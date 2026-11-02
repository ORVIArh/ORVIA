# Raw C4 pair primitive

`C4PairKernel` implements only the supplied attractive inverse-fourth-power term. It is an engineering candidate for the planned C4 role; it is not yet connected to the production Hamiltonian and does not complete that production role.

For displacement **d = b − a**, squared distance **s = d·d**, and a nonnegative supplied coefficient:

```text
U = −C4 / s²
F_A = +4 C4 d / s³
F_B = −F_A
```

Positive C4 therefore attracts the first atom toward the second. `evaluate(bytes16[3] displacement, bytes16 c4)` returns `(bytes16 energy, bytes16[3] forceOnA)`. The immutable `numericalMath` address supplies the existing binary128 `FloatMath` operations, and its deployment-time runtime hash is checked before evaluation. The kernel identity is `ORVIA.C4PairKernel.v1.RawUnswitched.BoundedBinary128`.

## Numerical domain

All operands must be finite. C4 must be zero or lie in `[2^-256, 2^256]`; each nonzero displacement component's magnitude must lie in that same interval. The computed binary128 squared distance must also lie in `[2^-256, 2^256]`. Zero-strength pairs still require valid, nonsingular geometry. Outputs canonicalize zero through `FloatMath`.

These broad limits are engineering bounds that keep active products and quotients away from underflow and overflow. They are not physical cutoffs, force-field fitting ranges, or an accepted molecular error budget. The fixed-point kernels are unchanged.

## Molecular-method boundary

The function is an **unswitched, uncut pair equation**. It selects no periodic image, pair-mixing rule, exclusion treatment, 1–4 scaling, switching function, long-range correction, or alchemical interpolation. A caller must bind those decisions to an independently validated complete protocol before integration. In particular, a disappearing atom's attractive C4 interaction must not be assumed safe merely because its repulsive Lennard-Jones term is softened.

The inspected native implementations do not establish one interchangeable full-method default:

| Inspected source | Relevant behavior |
| --- | --- |
| OpenMM 8.6.1 `openmm/app/internal/amber_file_parser.py` | Builds the C4 lookup potential, copies all `NonbondedForce` exceptions as custom-force exclusions, and uses periodic cutoff plus long-range correction for periodic/Ewald/PME modes. Its displayed C4 setup does not copy a switching function. |
| ParmEd 4.3.1 `parmed/amber/_amberparm.py` | Builds the same raw C4 equation, copies exception exclusions in the C4-only path, copies an enabled switching function from its nonbonded force, and enables long-range correction. |

Inspected source SHA-256 hashes are respectively `1e8a713cb6f641a9ece150973b6841be27463a971fd830200590d56a165a5a04` and `be23837b91fdda1c12165ea5a29000a157ef2a56086ca92e334540ddd5adc70d`. The preparation candidate itself leaves C4 exception/alchemical treatment and parameter transfers unaccepted. No native parameter file is accepted or changed by this kernel.

OpenMM documents cutoff truncation, optional switching, exclusions, and optional long-range correction separately in its [CustomNonbondedForce reference](https://docs.openmm.org/latest/api-python/generated/openmm.openmm.CustomNonbondedForce.html). Those choices must remain explicit; the primitive does not silently inherit any of them. The native coefficient conversion is `1 kcal Å⁴/mol = 4.184 × 10^-4 kJ nm⁴/mol`.

## Independent validation

Run `node --test test/c4-pair.test.mjs` with `ORVIA_RESEARCH_PYTHON` pointing to a Python environment containing mpmath. The test compiles its own dependencies in memory and writes only `reports/c4_pair_validation.json`. It invalidates the old report before compilation and binds source, test, reference, compiler input, and compiler version hashes.

The independent Python oracle decodes the submitted binary128 values and evaluates the scalar distance potential at **110 decimal digits**. It numerically differentiates that scalar potential with respect to all three coordinates of atom A, using additional guard precision for very small transverse components. It does not replay Solidity arithmetic. Agreement is checked with relative tolerance `1e-29` and absolute floor `1e-1000`.

The focused run covers all force components, swapped-pair antisymmetry, zero and signed-zero C4, exact power-of-two distance/coefficient scaling, numerical-domain boundaries and adjacent rejected values, singular geometry, negative/nonfinite inputs, and changed math runtime. Passing primitive checks does not certify an ensemble, full molecular calculation, or physical parameter set.

Recorded local gas: **845,861** for this kernel's deployment and **88,351** for one representative evaluation estimate. Its runtime is **3,644 bytes**. These exclude deployment of `FloatMath`, are not target-chain quotes, and do not measure a full force pass.
