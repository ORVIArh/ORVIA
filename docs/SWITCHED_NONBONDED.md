# Switched nonbonded pair component

`SwitchedNonbondedKernel` computes a declared cutoff Hamiltonian from an already selected displacement. Its normal interaction combines quintic-switched Lennard–Jones energy with the **infinite external dielectric (conducting) limit of reaction-field electrostatics**. This is a specific model choice for the v0.4 engineering fixture, not a validated choice for solvated cardiac myosin and not a periodic Ewald/PME sum.

## API and domains

Construction is `SwitchedNonbondedKernel(math, lj, coulomb)`. All three addresses must have deployed code. The two primitive kernels must expose the supplied `math` as their immutable `numericalMath`. Getters are `numericalMath`, `ljKernel`, `coulombKernel` and `KERNEL_ID`. The surrounding protocol must bind these executable identities; this component does not operate a registry itself.

```text
evaluate(displacement[3], sigma, epsilon, chargeProduct, prefactor,
         switchDistance, cutoff, exception)
    -> (energy, forceOnA[3])
```

All numerical inputs and outputs are binary128-format `bytes16`. The displacement is **b − a**, normally the nearest periodic image chosen by the geometry component. This kernel does not itself inspect a box, enumerate atom pairs, apply mixing rules, determine exclusions or infer a force field.

All operands must be finite, `sigma > 0`, `epsilon >= 0`, `prefactor >= 0`, and `0 < switchDistance < cutoff`. Charge product may have either sign. Zero separation is rejected even when all strengths are zero. Parameter and displacement validation precedes the cutoff shortcut. Intermediate overflow and invalid arithmetic propagate a revert from `FloatMath`; the implementation does not claim a complete error budget over every finite representable input.

## Declared normal-pair energy

Let `r = |displacement|`, `K = prefactor × chargeProduct`, `rs = switchDistance`, and `rc = cutoff`.

For `r < rc`:

```text
U_LJ = 4 epsilon [(sigma/r)^12 − (sigma/r)^6]
U_RF = K [1/r + r²/(2 rc³) − 3/(2 rc)]
U = S(r) U_LJ + U_RF
```

`S = 1` through `r = rs`. Between `rs` and `rc`, with `x = (r − rs)/(rc − rs)`, `S = 1 − 10x³ + 15x⁴ − 6x⁵`. At and beyond `rc`, both energy and force are canonical zero. The normal-pair potential and force approach zero continuously at the cutoff. No dispersion-tail correction, reciprocal-space sum, self energy, neutrality correction or dielectric fitting is included.

For `d = b − a`, the force on A is `(dU/dr) d/r`; the force on B is its negative. The switched LJ force includes **both** `S F_LJ` and `U_LJ (dS/dr) d/r`. Omitting the second contribution would make force inconsistent with the stored energy.

The implementation uses factorizations near the cutoff: `S = t³(10 − 15t + 6t²)` for `t = (rc − r)/(rc − rs)`, and `U_RF = K (1 − r/rc)² (r/rc + 2)/(2r)`. It evaluates the small gap from `rc − r` before division. These preserve the stated mathematical function while reducing cancellation. Upstream ABDK rounding behavior remains; this is not a claim of correctly rounded IEEE-754 operations.

## Exceptions

When `exception == true`, the result is the sum of the existing direct LJ and direct Coulomb kernels, without switching, reaction field or cutoff. The supplied parameters are already the exception's parameters. The caller still supplies and controls the displacement convention, and all ordinary input-domain checks still apply. Exclusions are handled before this kernel by the coordinator; an excluded pair is not represented by invoking this kernel at singular geometry with zero strengths.

The primary equation reference is the [OpenMM Standard Forces theory, sections 19.6.1–19.6.3](https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html), accessed 2026-11-02. The conducting-limit coefficients above follow by taking the external dielectric to infinity in the documented reaction-field coefficients. OpenMM documents direct treatment of nonbonded exceptions; choosing the geometric image convention remains a separate protocol decision.

## Validation evidence

`test/switched-nonbonded.test.mjs` compares 14 cases against mpmath scalar-potential differentiation at 90 decimal digits, starting from exactly decoded binary128 inputs. The reference does not reuse the contract's force formula, switching derivative or factored reaction-field expression. Cases cover both sides of the switching interval, the exact cutoff, a nearby point, non-axis geometry, charge signs, zero strengths and exceptions beyond the cutoff. The numerical report records every scalar error with absolute tolerance `1e-30` plus relative tolerance `1e-28`.

Additional checks cover finite coordinate-difference gradients, cutoff continuity, direct-exception equivalence, exchange symmetry, canonical zero, invalid domains and constructor dependencies. These checks establish the component's behavior on the fixtures. They do not establish molecular force-field accuracy, stable long trajectories, ensemble sampling or binding free energies.
