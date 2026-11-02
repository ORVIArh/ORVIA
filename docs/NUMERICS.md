# ORVIA numerical foundation v0.1

Status: implemented engineering component; full scientific platform validation remains pending.

This product includes software developed by ABDK Consulting.

## Representation and provenance

The initial reference implementation stores numbers in the IEEE 754 binary128 **format** (`bytes16`): a sign bit, a 15-bit exponent, and 112 explicitly stored fraction bits. The implementation uses the pinned ABDK Math Quad Solidity library at commit `5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554`, obtained from:

https://github.com/abdk-consulting/abdk-libraries-solidity

The unmodified vendored source, license and exact SHA-256 digest are in `contracts/math/vendor/`. The source checksum is `dd13f72bf828a699c94e96d1377daabce3dcc1d4b29af7215501a611d3cb7c9e`. The upstream BSD-4-Clause license and its attribution requirements apply to that code; the original ORVIA wrapper and kernel are MIT-licensed.

This is software floating-point arithmetic executed by Solidity contracts. Binary128 is chosen initially to provide ample reference precision while profiling costs. It does **not** establish that the full simulation is accurate. The upstream implementation's per-function rounding and approximation behavior is retained. ORVIA does not claim full IEEE 754 correctly-rounded-operation conformance, nor that 113 significant binary digits are achieved for every compound expression.

`FloatMath` is a deployable, stateless arithmetic contract. `HarmonicBondKernel` records its arithmetic-contract address immutably. A complete experiment must additionally pin the module bytecode hashes and version manifest.

## Current numerical behavior

- `add`, `sub`, `mul`, `div`, `sqrt`, `neg`, `abs`, comparison, and integer/binary64 conversion are exposed.
- Arithmetic rejects NaN and infinity as inputs or outputs.
- Division by either signed zero and square roots of negative nonzero values revert.
- Arithmetic results equal to zero are canonicalized to positive zero.
- Comparisons treat positive and negative zero as equal, normalizing signed-zero operands before calling the upstream comparator.
- Underflow, subnormal-number accuracy and cancellation follow the pinned upstream behavior. A production-domain bound and propagated-error budget have **not yet been established**.
- Conversion to binary64 is for inspection. The scientific state remains binary128. Binary64 overflow on inspection reverts.
- `fromInt`/`fromUInt` conversion of integers wider than binary128's significand can be inexact, following upstream conversion semantics.
- Elementary functions needed for full molecular dynamics/free-energy analysis, including exp/log/trigonometric functions, have not been exposed or validated by this wrapper.

The intended units follow an internally consistent molecular-dynamics convention: positions in nm, energies in kJ/mol, spring constants in kJ/mol/nm² and forces in kJ/mol/nm. The v0.3 `VelocityVerletKernel` additionally uses masses in unified atomic mass units and time in ps; see [DYNAMICS_NUMERICS.md](DYNAMICS_NUMERICS.md). Bounded angular functions are implemented separately in `ElementaryMath`, documented in [ANGULAR.md](ANGULAR.md).

Primary implementation specification for the physical bond term:
https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html#harmonicbondforce

## Implemented physical primitive

The bonded-force kernel evaluates one harmonic bond:

`U = (k/2) (r-r0)^2`, where `r = |b-a|`.

Its returned force on atom A is:

`F_A = k (r-r0) (b-a)/r`.

The force on atom B is `-F_A`. The sign makes an extended bond pull A toward B and a compressed bond push A away. Inputs must be finite and `k >= 0`, `r0 >= 0`; coincident atoms are rejected. `k = 0` is permitted for noncoincident atoms. Coordinates can be negative.

The primitive accepts an **unwrapped displacement**. It does not silently impose a minimum-image convention. Periodic image handling belongs to the declared full-system protocol and a future coordinate/neighbor module.

The current kernel covers no angle, torsion, nonbonded, long-range electrostatic, solvent, constraint, thermostat, integrator, alchemical or free-energy estimator terms. The fixture is a numerical engineering test, not ORVIA-001's cardiac-myosin experiment.

## Independent references and evidence boundaries

Run `python3 reference/generate_bond_vectors.py` to regenerate seven fixtures. The script uses 100-digit Python `Decimal` arithmetic and the scalar analytic energy/force equations, without importing or translating the vendored Solidity library. Inputs are exactly representable dyadic values. Five fixtures have multi-axis displacements; the set includes extension, compression, translation, irrational distance, equilibrium and zero spring constant.

Each fixture includes decimal reference energy/force values and independently rounded nearest-even binary128 reference encodings. Solidity is compared with a declared tolerance rather than presumed to follow the reference encoder's rounding policy. The default primitive-test tolerance is relative `1e-28` and absolute `1e-30`; this is an engineering test criterion, not an accepted production simulation error budget. The parent test harness records actual EVM results and observed errors.

Run `python3 -m unittest discover -s reference -p 'test_*.py'` to check fixture encoding, exact closed-form cases, force/energy gradient consistency and mechanical invariants using the independent reference implementation. These checks alone do not prove Solidity execution; the separate EVM test report is required for that claim.

Full acceptance later requires complete force-vector comparisons, stable integration, appropriate thermodynamic distributions and constraints, repeatable checkpoint/resume behavior, convergence diagnostics, and statistically consistent free-energy estimates. Agreement with another simulator does not by itself establish agreement with physical binding affinity.
