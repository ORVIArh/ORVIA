# Direct nonbonded pair components, v0.2

`LennardJonesKernel` and `CoulombPairKernel` evaluate one supplied pair at fixed, unwrapped coordinates. Energy and all three force components are calculated by the deployed `FloatMath` contract from the supplied binary128 operands. These are numerical primitives, not a complete nonbonded method, molecular-dynamics simulation, or binding free-energy calculation.

The energy conventions match the [OpenMM standard-force definitions for Lennard–Jones and Coulomb without a cutoff](https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html#nonbondedforce), consulted 1 November 2026. The force expressions below follow by differentiating those energies. No OpenMM simulation output is used as the fixture oracle.

## Interface and equations

Each contract has an immutable `numericalMath()` getter, a versioned `KERNEL_ID`, and a constructor taking the deployed `FloatMath` address. Constructor validation rejects an address without code. A calling protocol must additionally pin and validate the specific numerical implementations and their dependencies; this constructor does not authenticate arbitrary supplied bytecode.

Both interfaces return `(bytes16 energy, bytes16[3] forceOnA)`:

```solidity
LennardJonesKernel.evaluate(bytes16[3] a, bytes16[3] b, bytes16 sigma, bytes16 epsilon)
CoulombPairKernel.evaluate(bytes16[3] a, bytes16[3] b, bytes16 chargeProduct, bytes16 prefactor)
```

Define displacement \(\mathbf d=\mathbf b-\mathbf a\), separation \(r=|\mathbf d|\), and \(s=\sigma/r\). Lennard–Jones uses

\[
U_{LJ}=4\epsilon(s^{12}-s^6),\qquad
\mathbf F_A=24\epsilon(s^6-2s^{12})\frac{\mathbf d}{r^2}.
\]

The pair parameters must satisfy \(\sigma>0\) and \(\epsilon\ge0\). Sigma is the separation where energy is zero; the minimum occurs at \(2^{1/6}\sigma\). The contract computes \(s^2=\sigma^2/r^2\) and then integer powers using multiplications, so this kernel requires no transcendental operation or square root. Pair parameters are explicit: the kernel does not select a mixing rule, assign atom types, or derive exclusions.

For Coulomb, write \(Q=\texttt{chargeProduct}\) and \(C=\texttt{prefactor}\):

\[
U_C=\frac{CQ}{r},\qquad
\mathbf F_A=-\frac{CQ}{r^3}\mathbf d.
\]

The charge product is signed and the prefactor must be nonnegative. Positive charge product produces repulsion and negative product attraction. The calling protocol must register the chosen prefactor, charge convention, and units; no numerical electrostatic constant or dielectric model is silently chosen here. The implementation evaluates the force scale as \(-U_C/r^2\).

For both kernels, the force on B is the negative of the returned force on A. They do not mutate coordinates, enumerate other pairs, or accumulate system forces.

## Input and numerical limits

All coordinates and parameters must be finite. Both signed zeros are accepted for epsilon, charge product, and prefactor; sigma cannot be either zero. Zero separation is rejected even when the interaction strength is zero. Once the geometry is validated, zero strength returns canonical positive zero for energy and force.

The shared arithmetic uses the IEEE binary128 storage format with the pinned ABDK implementation and its existing rounding behavior, as described in [NUMERICS.md](NUMERICS.md). Overflow and other nonfinite arithmetic results revert. This is not a guarantee over every finite binary128 input: intermediate displacement squares or powers can overflow, and extremely small squared separations can underflow to zero and be rejected. Other underflow can round a small result to zero. Production work still needs an accepted coordinate/parameter range and a complete numerical error budget. Unregularized Lennard–Jones and Coulomb interactions are singular at coincident positions.

Any internally consistent unit system can be declared. For example, with coordinates and sigma in nm and energy/epsilon in kJ/mol, force is in kJ/mol/nm. If charge product is in elementary-charge units squared, prefactor must have units kJ/mol·nm per elementary-charge unit squared. The fixtures use mathematical test values and do not establish force-field parameters for ORVIA-001.

## Validation evidence

`reference/generate_nonbonded_vectors.py` evaluates the analytic equations independently using Python's 100-digit `Decimal` arithmetic. Its seven LJ and seven Coulomb cases cover repulsive and attractive pairs, translated and general three-dimensional geometries, irrational distances, and zero strengths. The near-minimum LJ case uses the exact value of the nearest binary128 representation of \(2^{1/6}\); its expected force is small but not exactly zero. Every input is verified to be exactly representable in binary128, avoiding a comparison against unrounded input values.

`reference/test_nonbonded_reference.py` checks the independent oracle's analytical signs, finite-difference gradients, particle exchange, translation, zero strengths, domains, input encoding and fixture reproducibility. `test/nonbonded.test.mjs` deploys the actual math and kernels on a local EVM, compares returned binary128 values directly to those Decimal expectations, checks gradients and exact simple values, tests exchange/translation symmetry, and checks rejected inputs. The reference comparison uses absolute tolerance `1e-30` plus relative tolerance `1e-28`; this is a component acceptance tolerance, not a production molecular-simulation error budget. In particular, the absolute tolerance does not resolve the sign of the tiny near-minimum force.

Run from the project root:

```sh
python3 -m unittest discover -s reference -p 'test_nonbonded_reference.py'
npm run compile
node --test test/nonbonded.test.mjs
```

The EVM test writes `reports/nonbonded_validation.json` after successful oracle comparison. Completed test outputs, rather than the existence of the test files, establish the validation status.

These components do not implement cutoffs or switching functions, periodic minimum images, reaction fields, Ewald/PME, long-range dispersion corrections, softcore alchemical interactions, neighbor lists, topology exclusions, or a complete force field. They provide no claim of a full-system energy, a converged trajectory, a drug-affinity result, or medical efficacy.
