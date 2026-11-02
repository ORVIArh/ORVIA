# Periodic dynamics reference and evidence boundary

`reference/generate_periodic_reference.py` generates a four-atom, three-step orthorhombic trajectory using mpmath 1.3.0 at 90 decimal digits. It differentiates an independently written scalar potential with `mpmath.diff` to obtain forces. It does not call Solidity, import its force expressions, or submit any computed state to the production engine. The only shared Python utilities are vector dot/cross/norm operations and binary128 input encoding.

All declared input numbers are dyadic and exactly representable in binary128. The saved fixture contains exact encoded inputs, their decimal counterparts, the six initial pair classifications and four checkpoints. Each checkpoint records positions, velocities, forces, potential energy, kinetic energy, total energy, linear momentum, center of mass and energy-family contributions. Contract comparison uses positions, velocities, forces and potential energy: 37 scalar values per checkpoint, 148 across the four checkpoints. Diagnostic kinetic energy and momentum remain reference observables unless a contract test explicitly checks them.

## Declared model

The oracle applies an orthorhombic nearest-image displacement to every bond, both arms of an angle, each successive torsion bond and every non-excluded pair. It stores and integrates unwrapped coordinates. Truncation removes whole cell lengths; a remaining displacement strictly above positive half the cell is reduced by one cell, and one strictly below negative half is increased by one cell. Exact half-cell ties retain their remainder sign. The primitive preserves pair antisymmetry at ties. The supported force domain rejects any exact half-cell component in a bonded displacement or direct exception because its image is ambiguous. Ordinary pairs with such a component are outside the strict half-cell cutoff and contribute zero. Force derivatives and image-invariance checks use non-tied configurations.

All unordered pairs are enumerated. Ordinary pairs use the arithmetic mean of atom sigmas, geometric mean of atom epsilons and product of atom charges. An explicit exclusion contributes zero. An explicit override supplies its own sigma, epsilon and charge product and remains active beyond the normal cutoff. Overrides use direct Lennard–Jones and Coulomb potentials with nearest images and no switch. This is a declared model convention, not a generic guarantee of compatibility with a particular biomolecular force field.

For ordinary pairs, the LJ switch is `1 - 10*x^3 + 15*x^4 - 6*x^5`, where `x=(r-rs)/(rc-rs)`, applied between switch distance `rs` and cutoff `rc`. The Coulomb potential inside the cutoff is `prefactor*qProduct*(1/r + r^2/(2*rc^3) - 3/(2*rc))`. This is the conducting-dielectric limit of the reaction-field equation. At and beyond `rc`, ordinary pair energies and forces are zero. The LJ switch derivative is part of the force; differentiating only the unswitched energy would be incorrect.

The scalar formulas and combining convention follow the [OpenMM standard-force theory](https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html), sections 19.6.1–19.6.3, accessed 2026-11-02. The conducting limit is obtained algebraically by taking the solvent dielectric to infinity in its stated reaction-field coefficients. This source is a formula reference; the current tests do not run OpenMM or demonstrate equivalence across its full option set.

## Fixture coverage

The fixed box is `(8,8,8)`, the switch distance is 2, cutoff is 3 and timestep is `1/128`. The run covers `3/128` time units. It has three bonds, two angles, one torsion, four atom parameter records and two exception records. Every force family has a nonzero initial energy contribution.

| Pair | Initial treatment |
|---|---|
| 0–1 | Excluded |
| 0–2 | Ordinary, below switch distance |
| 0–3 | Ordinary, beyond cutoff |
| 1–2 | Direct parameter override |
| 1–3 | Ordinary, within switching interval |
| 2–3 | Ordinary, below switch distance |

Initial coordinates split the bonded chain across the x face of the periodic box. A common x velocity of 16 plus small atom-specific offsets makes atom 0 cross x=8 during the trajectory, finishing at approximately 8.12536569594. That common velocity is deliberately chosen to exercise the boundary and unwrapped storage; it is not an equilibrated temperature or a proposed molecular preparation. The synthetic Coulomb prefactor is 1; these charges and strengths do not constitute a physical solvent or protein parameter set.

## Reference checks

`reference/test_periodic_reference.py` has 13 tests:

- Exact binary128 representation of every input and deterministic regeneration of the JSON fixture.
- Nonzero energy-family coverage and each expected pair classification.
- Force comparison with a separately evaluated centered finite difference.
- Independent integer-cell shifts of individual atoms preserving energies and forces away from image ties.
- Multiple-image reduction, primitive antisymmetry at exact half-cell ties, and rejection of ambiguous bonded/direct-exception force geometry.
- Internal-force cancellation, linear momentum conservation and uniform center-of-mass motion in unwrapped coordinates.
- Velocity-Verlet time reversal and timestep refinement.
- One-sided energy and force continuity at the switch and cutoff.
- Direct exceptions remaining active beyond the cutoff and exclusion processing before pair geometry.
- Periodic face crossing in the main fixture and a separate two-atom cutoff-crossing oracle case.

The separate cutoff-crossing case is an oracle sanity test; it does not by itself establish EVM behavior. Likewise, a coincident excluded pair is accepted only at the pair layer: other bonded terms can still make the same configuration singular.

At equal total simulated time, the main oracle's absolute total-energy drift is approximately `2.49369442519e-9`; halving the timestep reduces it to `6.23421574191e-10`, a ratio of `0.2499991851`. These are high-precision reference-integration measurements, not gas measurements or a guarantee of long-run stability.

The contract comparison threshold is `1e-25 + 1e-24*abs(reference)`. It is a short-fixture engineering criterion, not a general binary128 correctness proof or a propagated-error budget for solvated proteins. Actual measured EVM deviations belong in the integration report. No oracle result proves thermostat sampling, long-range Ewald/PME accuracy, neighbor-list correctness, alchemical free-energy convergence or clinical effect.

## Reproduction

Run from the project root with the pinned research environment:

```bash
.venv-research/bin/python reference/generate_periodic_reference.py
.venv-research/bin/python -m unittest discover -s reference -p test_periodic_reference.py -v
```

The full validation runner also discovers these tests. The reference JSON contains no trajectory values received from the contracts.
