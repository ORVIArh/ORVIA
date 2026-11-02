"""Lossless binary64 parameter path for small, nonperiodic endpoint diagnostics.

OpenMM b399af4 native GPU bonded/nonbonded kernels store force-field parameters
as float32 even in double mode. CustomCompoundBondForce retains binary64
per-bond parameters in double mode. This module expresses the same supported
Hamiltonian through that path; it does not change prepared input files.

The quadratic nonbonded expansion is deliberately limited to 256 particles.
This is not a production full-system implementation or a PME replacement.
"""
from __future__ import annotations

import math
import struct


COULOMB = 1 / (4 * math.pi * (1e-6 * 8.8541878128e-12 /
                            (1.602176634e-19**2 * 6.02214076e23)))


def float32(value):
    return struct.unpack("f", struct.pack("f", float(value)))[0]


def endpoint_system(mm, unit, source, emulate_gpu_rounding=False):
    """Return an equivalent small endpoint, or a diagnostic rounded surrogate.

    The rounded surrogate emulates native CUDA double parameter arithmetic,
    not CUDA execution. Its output must never be called a CUDA result.
    """
    n = source.getNumParticles()
    if not 1 <= n <= 256:
        raise ValueError("Precision endpoint diagnostic supports 1..256 particles only")
    if source.usesPeriodicBoundaryConditions() or source.getNumConstraints():
        raise ValueError("Only unconstrained, nonperiodic endpoints are supported")
    if any(source.isVirtualSite(i) for i in range(n)):
        raise ValueError("Virtual sites are unsupported")
    target = mm.System()
    target.setDefaultPeriodicBoxVectors(*source.getDefaultPeriodicBoxVectors())
    for i in range(n):
        target.addParticle(source.getParticleMass(i))
    q = float32 if emulate_gpu_rounding else float

    def scalar(x, u):
        return float(x.value_in_unit(u))

    def force(original, count, expression, parameters):
        result = mm.CustomCompoundBondForce(count, expression)
        for name in parameters:
            result.addPerBondParameter(name)
        result.setForceGroup(original.getForceGroup())
        result.setName(original.getName() + (" [GPU parameter surrogate]" if
                       emulate_gpu_rounding else " [binary64 parameter path]"))
        target.addForce(result)
        return result

    for original in source.getForces():
        if isinstance(original, mm.HarmonicBondForce):
            result = force(original, 2, "0.5*k*(distance(p1,p2)-r0)^2", ["r0", "k"])
            for i in range(original.getNumBonds()):
                a, b, r, k = original.getBondParameters(i)
                result.addBond([a, b], [q(scalar(r, unit.nanometer)),
                    q(scalar(k, unit.kilojoule_per_mole / unit.nanometer**2))])
        elif isinstance(original, mm.HarmonicAngleForce):
            result = force(original, 3, "0.5*k*(angle(p1,p2,p3)-theta0)^2", ["theta0", "k"])
            for i in range(original.getNumAngles()):
                a, b, c, angle, k = original.getAngleParameters(i)
                result.addBond([a, b, c], [q(scalar(angle, unit.radian)),
                    q(scalar(k, unit.kilojoule_per_mole / unit.radian**2))])
        elif isinstance(original, mm.PeriodicTorsionForce):
            result = force(original, 4, "k*(1+cos(n*dihedral(p1,p2,p3,p4)-phase))",
                           ["n", "phase", "k"])
            for i in range(original.getNumTorsions()):
                a, b, c, d, periodicity, phase, k = original.getTorsionParameters(i)
                result.addBond([a, b, c, d], [float(periodicity), q(scalar(phase, unit.radian)),
                    q(scalar(k, unit.kilojoule_per_mole))])
        elif isinstance(original, mm.NonbondedForce):
            if (original.getNonbondedMethod() != mm.NonbondedForce.NoCutoff
                    or original.getNumParticleParameterOffsets()
                    or original.getNumExceptionParameterOffsets()
                    or original.getNumGlobalParameters()
                    or not original.getIncludeDirectSpace()):
                raise ValueError("Only NoCutoff, fixed-parameter direct nonbonded endpoints are supported")
            result = force(original, 2,
                "c/r+epsilon4*((sigma/r)^12-(sigma/r)^6); r=distance(p1,p2)",
                ["c", "sigma", "epsilon4"])
            particles = []
            for i in range(n):
                charge, sigma, epsilon = original.getParticleParameters(i)
                particles.append((q(scalar(charge, unit.elementary_charge)),
                                  q(scalar(sigma, unit.nanometer)),
                                  q(scalar(epsilon, unit.kilojoule_per_mole))))
            exceptions = {}
            for i in range(original.getNumExceptions()):
                a, b, charge, sigma, epsilon = original.getExceptionParameters(i)
                exceptions[tuple(sorted((a, b)))] = (
                    q(scalar(charge, unit.elementary_charge**2)),
                    q(scalar(sigma, unit.nanometer)), q(scalar(epsilon, unit.kilojoule_per_mole)))
            for a in range(n):
                qa, sa, ea = particles[a]
                for b in range(a + 1, n):
                    if (a, b) in exceptions:
                        charge, sigma, epsilon = exceptions[a, b]
                        c, epsilon4 = q(COULOMB * charge), q(4 * epsilon)
                    else:
                        qb, sb, eb = particles[b]
                        c = COULOMB * qa * qb
                        if emulate_gpu_rounding:
                            # float2 sigmaEpsilon and float add/multiply in the
                            # common nonbonded kernel, even when real=double.
                            sigma = q(q(0.5 * sa) + q(0.5 * sb))
                            epsilon4 = q(q(2 * math.sqrt(ea)) * q(2 * math.sqrt(eb)))
                        else:
                            sigma, epsilon4 = (sa + sb) / 2, 4 * math.sqrt(ea * eb)
                    if c or epsilon4:
                        result.addBond([a, b], [c, sigma, epsilon4])
        else:
            raise ValueError("Unsupported force: " + type(original).__name__)
    return target
