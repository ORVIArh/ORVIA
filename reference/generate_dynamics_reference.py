#!/usr/bin/env python3
"""Independent high-precision small-system dynamics oracle.

Forces are numerical derivatives of the complete scalar Hamiltonian through
mpmath.diff, not a translation of the Solidity analytical force expressions.
The model is a deliberately small, nonperiodic validation fixture, not myosin.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import mpmath as mp

from generate_bond_vectors import binary128_nearest


PRECISION = 90
MPMATH_VERSION = "1.3.0"
INPUT = {
    "positions": [["0", "0", "0"], ["1", "0", "0"],
                  ["1.5", "1", "0.125"], ["2", "1.25", "1.125"]],
    "particles": [["12", "0.015625", "-0.0078125", "0"],
                  ["14", "0", "0.0078125", "-0.015625"],
                  ["16", "-0.0078125", "0", "0.0078125"],
                  ["12", "0.0078125", "-0.015625", "0.015625"]],
    "bonds": [[0, 1, "2", "1"], [1, 2, "3", "1"], [2, 3, "2", "1"]],
    "angles": [[0, 1, 2, "0.5", "1.5"], [1, 2, 3, "0.75", "1.75"]],
    "torsions": [[0, 1, 2, 3, 2, "0.25", "0.5"]],
    "pairs": [[0, 3, "0.5", "0.125", "-0.25", "1"]],
    "dt": "0.0078125",
    "steps": 8,
}


def vector_sub(a, b):
    return [x - y for x, y in zip(a, b)]


def dot(a, b):
    return mp.fsum(x * y for x, y in zip(a, b))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def norm(a):
    return mp.sqrt(dot(a, a))


def energy_terms(positions, source=INPUT):
    """Scalar Hamiltonian. Positions may include mpmath derivative perturbations."""
    terms = {name: mp.mpf(0) for name in ("bonds", "angles", "torsions", "lennard_jones", "coulomb")}
    for a, b, k, r0 in source["bonds"]:
        extension = norm(vector_sub(positions[b], positions[a])) - mp.mpf(r0)
        terms["bonds"] += mp.mpf(k) * extension**2 / 2
    for a, b, c, k, theta0 in source["angles"]:
        u = vector_sub(positions[a], positions[b])
        v = vector_sub(positions[c], positions[b])
        theta = mp.acos(dot(u, v) / (norm(u) * norm(v)))
        terms["angles"] += mp.mpf(k) * (theta - mp.mpf(theta0))**2 / 2
    for a, b, c, d, periodicity, k, phase in source["torsions"]:
        b1 = vector_sub(positions[b], positions[a])
        b2 = vector_sub(positions[c], positions[b])
        b3 = vector_sub(positions[d], positions[c])
        n1, n2 = cross(b1, b2), cross(b2, b3)
        phi = mp.atan2(dot(b2, cross(n1, n2)) / norm(b2), dot(n1, n2))
        terms["torsions"] += mp.mpf(k) * (1 + mp.cos(periodicity * phi - mp.mpf(phase)))
    for a, b, sigma, epsilon, charge_product, prefactor in source["pairs"]:
        distance = norm(vector_sub(positions[b], positions[a]))
        ratio = mp.mpf(sigma) / distance
        terms["lennard_jones"] += 4 * mp.mpf(epsilon) * (ratio**12 - ratio**6)
        terms["coulomb"] += mp.mpf(prefactor) * mp.mpf(charge_product) / distance
    return terms


def potential(positions, source=INPUT):
    return mp.fsum(energy_terms(positions, source).values())


def forces(positions, source=INPUT):
    result = []
    for atom, position in enumerate(positions):
        row = []
        for axis, coordinate in enumerate(position):
            def energy_at(value):
                perturbed = [list(p) for p in positions]
                perturbed[atom][axis] = value
                return potential(perturbed, source)
            row.append(-mp.diff(energy_at, coordinate))
        result.append(row)
    return result


def initial_state(source=INPUT):
    x = [[mp.mpf(value) for value in row] for row in source["positions"]]
    v = [[mp.mpf(value) for value in row[1:]] for row in source["particles"]]
    masses = [mp.mpf(row[0]) for row in source["particles"]]
    return x, v, masses


def advance(x, v, f, masses, dt, source=INPUT):
    half = [[v[i][axis] + dt * f[i][axis] / (2 * mass) for axis in range(3)]
            for i, mass in enumerate(masses)]
    new_x = [[x[i][axis] + dt * half[i][axis] for axis in range(3)] for i in range(len(x))]
    new_f = forces(new_x, source)
    new_v = [[half[i][axis] + dt * new_f[i][axis] / (2 * mass) for axis in range(3)]
             for i, mass in enumerate(masses)]
    return new_x, new_v, new_f


def observables(x, v, masses, source=INPUT):
    kinetic = mp.fsum(masses[i] * dot(v[i], v[i]) / 2 for i in range(len(x)))
    potential_energy = potential(x, source)
    total_mass = mp.fsum(masses)
    return {
        "potential_energy": potential_energy,
        "kinetic_energy": kinetic,
        "total_energy": potential_energy + kinetic,
        "linear_momentum": [mp.fsum(masses[i] * v[i][axis] for i in range(len(x))) for axis in range(3)],
        "center_of_mass": [mp.fsum(masses[i] * x[i][axis] for i in range(len(x))) / total_mass for axis in range(3)],
    }


def simulate(*, dt=None, steps=None, source=INPUT, positions=None, velocities=None):
    x, v, masses = initial_state(source)
    if positions is not None:
        x = [list(row) for row in positions]
    if velocities is not None:
        v = [list(row) for row in velocities]
    dt = mp.mpf(source["dt"] if dt is None else dt)
    steps = source["steps"] if steps is None else steps
    f = forces(x, source)
    history = [{"step": 0, "positions": x, "velocities": v, "forces": f,
                **observables(x, v, masses, source)}]
    for step in range(1, steps + 1):
        x, v, f = advance(x, v, f, masses, dt, source)
        history.append({"step": step, "positions": x, "velocities": v, "forces": f,
                        **observables(x, v, masses, source)})
    return history


def decimal(value):
    return mp.nstr(value, n=PRECISION, strip_zeros=False)


def encode_inputs(source=INPUT):
    encoded = deepcopy(source)
    for stream, float_start in (("positions", 0), ("particles", 0), ("bonds", 2),
                                ("angles", 3), ("torsions", 5), ("pairs", 2)):
        encoded[stream] = [row[:float_start] + [binary128_nearest(value) for value in row[float_start:]]
                           for row in source[stream]]
    encoded["dt"] = binary128_nearest(source["dt"])
    return encoded


def generate_payload():
    if mp.__version__ != MPMATH_VERSION:
        raise RuntimeError(f"Expected mpmath {MPMATH_VERSION}, found {mp.__version__}")
    with mp.workdps(PRECISION):
        history = simulate()
        checkpoints = []
        for state in history:
            record = {"step": state["step"]}
            for name in ("positions", "velocities", "forces"):
                record[name + "_decimal"] = [[decimal(value) for value in row] for row in state[name]]
            for name in ("potential_energy", "kinetic_energy", "total_energy"):
                record[name + "_decimal"] = decimal(state[name])
            for name in ("linear_momentum", "center_of_mass"):
                record[name + "_decimal"] = [decimal(value) for value in state[name]]
            record["energy_terms_decimal"] = {name: decimal(value) for name, value in energy_terms(state["positions"]).items()}
            checkpoints.append(record)
        return {
            "schema_version": "orvia.dynamics.reference.v0.3",
            "scope": "Four-atom nonperiodic validation fixture only, not a prepared protein or binding-free-energy calculation.",
            "generator": {"library": "mpmath", "version": MPMATH_VERSION,
                          "decimal_digits": PRECISION,
                          "forces": "Negative mpmath.diff derivatives of independent scalar energy equations",
                          "integrator": "Velocity Verlet, without constraints or thermostat"},
            "units": {"position": "nm", "time": "ps", "mass": "Da", "energy": "kJ/mol",
                      "force": "kJ/mol/nm", "angle": "radian"},
            "comparison": {"absolute_tolerance": "1e-25", "relative_tolerance": "1e-24",
                           "note": "Short-fixture engineering criterion; not a production molecular-simulation error budget."},
            "input_decimal": deepcopy(INPUT),
            "inputs": encode_inputs(),
            "checkpoints": checkpoints,
        }


def main():
    payload = generate_payload()
    path = Path(__file__).with_name("dynamics_reference.json")
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {len(payload['checkpoints'])} independent trajectory checkpoints to {path}")


if __name__ == "__main__":
    main()
