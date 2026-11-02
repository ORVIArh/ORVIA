# Bounded fixed-point arithmetic candidate

This is a separate numerical policy under development. It is **not admitted to an ORVIA scientific campaign**, is not bitwise equivalent to the original ABDK binary128 implementation, and has not been validated on a complete prepared molecular trajectory. The measured savings below are standalone local component measurements.

## Arithmetic policy

The external ABI still encodes scalars as binary128 `bytes16`. `Fixed96Math` converts finite inputs to signed integers representing a value multiplied by 2^96, using nearest rounding with ties to even. Positive and negative zero become canonical zero. Nonzero inputs that would round to zero, binary128 subnormals, infinities and NaNs are rejected. Accepted nonzero inputs therefore need magnitude greater than approximately 2^-97; that condition alone does not establish valid intermediates.

Every arithmetic intermediate checked by the helpers is restricted to [-2^30, 2^30] in physical units. Multiplication and division truncate toward zero. The signed raw operands are bounded by 2^126, so their product fits 252 magnitude bits and the division numerator fits 222. Addition and subtraction cannot overflow the Solidity signed integer before their range check. The square-root routine computes the floor integer square root of the scaled radicand; the result is converted back to binary128 with nearest, ties-even rounding. No force clipping, minimum separation or hidden physical softening is introduced. A finite physical input can still revert because a derivative or another intermediate leaves the declared domain. A nonzero displacement can produce an under-resolved squared distance and be rejected.

The conversion/overflow reasoning does not prove an error bound for every molecular geometry. Admission needs the registered parameters, geometry and complete intermediate domains, plus a scientific error budget. In particular, an input parameter range check is insufficient for a close-contact force.

## Potentials and elementary functions

`FixedPointNonbondedKernel` evaluates the original quintic switched Lennard-Jones plus conducting reaction-field pair, or a direct exception pair. Reaction field is not a substitute for the selected finite Ewald Hamiltonian.

`Fixed96LennardJonesKernel` provides the ordinary Lennard-Jones component used for unchanged endpoint parameters. Calling the soft-core formula at an interior lambda is not a substitute for this ordinary potential.

`Fixed96SoftcoreLennardJonesKernel` evaluates both endpoint soft-core potentials, their combined energy and force, and the lambda derivative. It uses the same declared scalar potential as `SoftcoreLennardJonesKernel`, with different arithmetic and finite domains. Its v2 policy factors the physical force and lambda derivative before division, avoiding an unnecessary large `dU/drho` intermediate at finite softened overlaps. This is an explicit operation-order change from the earlier unadmitted v1 candidate, with a new implementation identifier. Zero epsilon makes an endpoint's Lennard-Jones contribution identically zero. The ABI still requires positive sigma; native zero-sigma, zero-epsilon sites require an explicit, source-audited inert-sigma normalization in preparation rather than an undisclosed parameter change.

`Fixed96EwaldRealSpaceKernel` evaluates the unshifted, erfc-screened real-space pair below its cutoff. `Fixed96EwaldReciprocalKernel` evaluates one canonical half-space mode's wave vector, structure-factor terms, mode energy and force contribution. Neither alone is a complete Ewald sum. Mode enumeration, truncation accuracy, self/background/exclusion corrections and committed-state authentication remain responsibilities of the connected evaluator.

The Ewald arithmetic uses fixed constants for pi and 1/sqrt(pi), rounded to Q96. `exp(-z)` supports 0 <= z <= 256: divide the exponent by 256, evaluate up to 32 Taylor terms, then square eight times. Positive erfc supports 0 <= x <= 16: the positive series with at most 64 terms below 2 and the 128-level DLMF 7.9.2 continued fraction at or above 2. Sine/cosine use up to 32 recurrence steps on a coordinate-reduced angle in [-pi, pi]. A series exits early only after its recurrence terms become exactly zero, which makes every later Q96 term zero as well. These are deterministic approximations, not correctly rounded transcendental functions. Internal values below fixed resolution can become zero, including negligible exponential tails. This truncation belongs to the new numerical policy and must be covered by its error budget.

All source/runtime identities and policy identifiers must be pinned explicitly. These candidates do not expose a misleading `numericalMath()` getter claiming they use the original FloatMath dependency. The same admitted Hamiltonian must produce both sampled-state forces and every cross-state energy.

## Current evidence

`test/fixedpoint-nonbonded.test.mjs` checks 132 charged ordinary/direct and switch-boundary inputs plus 64 ordinary Lennard-Jones inputs against an independent 110-digit scalar potential and differentiated forces. Its predeclared component tolerance is absolute 1e-20 plus relative 1e-18, alongside unsupported-domain rejection checks. `reports/fixedpoint_pair_validation.json` records each error.

`test/fixed96-softcore.test.mjs` independently checks 71 energy/force/lambda-derivative cases, including six actual prepared-hybrid pair types across seven lambda values and three overlapping/near-overlapping born-atom contacts. All passed both its predeclared absolute 1e-18 plus relative 1e-16 tolerance and the stricter pair budget above. The maximum observed absolute error was 9.051e-19, on a large derivative covered by the relative tolerance. The actual born-atom overlap at lambda 0.875 now passes the independent oracle instead of failing because of `dU/drho`. Seventeen unsupported cases are rejected, including a softened contact at lambda 0.999 whose physical outputs leave the supported range. Finite physical inputs can still exceed another intermediate bound; full trajectory admission remains separate. The rejections are retained in `reports/fixed96_softcore_domains.json`.

`test/fixed96-ewald.test.mjs` checks screened pairs, reciprocal terms, wave vectors, energies and forces against an independent 110-digit reference at the same predeclared tolerance. It also checks periodic translations, canonical mode rejection and invalid numerical domains. `reports/fixed96_ewald_validation.json` records each error. These finite fixtures are not a universal error proof or a full-system convergence study.

Output-consuming repeated static calls on a local Shanghai EVM measured the following favorable warm-call locality. Every implementation's returned bytes are independently consumed; cross-implementation byte equality is deliberately not required by this different policy.

| Component | Original binary128 gas | Candidate gas |
| --- | ---: | ---: |
| Switched/RF pair below switch | 80,391 | 44,072 |
| Switched/RF pair inside switch | 115,637 | 57,253 |
| Soft-core pair, interior lambda | 188,593 | 52,419 |
| Soft-core born-atom pair | 134,997 | 41,335 |
| Ewald real pair, small-argument branch | 293,720 | 96,419 |
| Ewald real pair, continued-fraction branch | 751,686 | 288,980 |
| Reciprocal structure-factor term | 685,632 | 66,816 |

The source-bound tests regenerate `reports/fixedpoint_pair_gas.json` and `reports/fixed96_ewald_gas.json`. These numbers exclude the full simulation's state access, topology lookup, accumulation, checkpointing, analysis and chain fee costs. They are not a campaign cost estimate or mainnet throughput claim.

The optional online `scripts/probe_fixed96_target.mjs` recompiles the exact source files and compares creation runtimes and numerical return bytes at a pinned Robinhood provider block using read-only `eth_call` and ephemeral state overrides. Its report is supplementary online evidence, not an offline-suite check or a production deployment. The script has no send/sign RPC operation.
