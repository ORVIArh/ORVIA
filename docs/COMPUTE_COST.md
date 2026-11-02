# Optional inline arithmetic: measured pair-kernel improvement

Inlining the existing pinned binary128 arithmetic reduces the measured warm pair cost by **51–53%**, approximately **2.1×**. The change is material, but it does not establish full-protein RBFE feasibility. The kernel is now selectable by the bounded neighbor NVE coordinator under an explicit runtime admission policy; other coordinators retain the original implementation.

`contracts/kernels/InlineNonbondedKernel.sol` computes the same quintic-switched Lennard-Jones plus conducting reaction-field energy and force as `SwitchedNonbondedKernel`. Exceptions still use direct, uncut LJ plus Coulomb. It introduces no Ewald/PME method, alchemical model, approximation or reduced-precision arithmetic.

## What changed

The original path makes external calls to `FloatMath`, `LennardJonesKernel` and `CoulombPairKernel`. The optional kernel places the same finite-domain binary128 wrappers and primitive calculations inside one contract. It imports the unchanged pinned `ABDKMathQuad` library. Every source arithmetic expression, intermediate assignment, validation branch and zero-result canonicalization from the v0.4 pair path is retained. Duplicate distance calculations and primitive validation are intentionally preserved rather than algebraically rewritten.

This removes contract-call and ABI overhead and allows the compiler to optimize internal calls. It does not replace binary128 arithmetic with raw integer or binary64 calculations. ABDK's existing rounding and approximation behavior remains; this is not a new claim of universal correctly rounded IEEE-754 behavior.

The ABI still accepts the displacement, sigma, epsilon, charge product, prefactor, switch distance, cutoff and exception flag. `evaluate` is pure. There are **no constructor arguments and no external arithmetic dependency**. In particular, the contract does not expose or pretend to use a `numericalMath` address.

On-chain provenance constants expose upstream commit `5e1e7c11b35f8313d3f7ce11c1b86320d7c0b554`, the imported source SHA-256, a kernel implementation ID and the finite-wrapper arithmetic implementation ID. The latter identifies retained numerical behavior; it is not a deployed `FloatMath` dependency. The validation report records compiler/settings, complete standard-input hash, individual source hashes, creation-bytecode hash and the exact deployed runtime hash.

## Gas evidence

Both implementations are measured in the same fresh local Ganache Shanghai EVM with solc 0.8.26, optimizer 200 and the same test-only `PairWorkMeter`. Each branch uses 0, 1, 2, 4 and 8 repeated evaluations. There are **20 actual benchmark transactions** across both implementations. The emitted output digest is verified for every transaction.

| Charged, nonzero branch | Original warm call | Inline warm call | Reduction | Original / inline |
|---|---:|---:|---:|---:|
| Below switch | 172,630 gas | 80,391 gas | 53.43% | 2.147× |
| Inside switch | 237,459 gas | 115,637 gas | 51.30% | 2.053× |

Warm cost is the minimum of calls 2–8 in the eight-pair transaction, measured immediately around the external kernel call. It includes call/return marshalling and a small meter-instruction overhead. It excludes transaction intrinsic gas, the outer loop, checksum and event. The report also stores all receipts, per-call gas, zero-pair baselines and baseline-subtracted execution totals. The same exact nonzero inputs and favorable repeated-input locality are used for both kernels; see `WORKLOAD_FEASIBILITY.md` for input values and measurement interpretation.

The inline runtime is **7,587 bytes**, below the ordinary 24 KiB EVM code limit and the larger documented Robinhood limit. Its local deployment used **1,693,811 gas**. These measurements do not verify Robinhood's live gas schedule or L1/data fee calculation.

## Numerical and domain validation

The standalone test compiles the comparison sources in memory and verifies:

- **90 successful cases**, comparing energy and all three force components byte for byte against the original implementation. Cases include the complete existing v0.4 branch/boundary/exchange/zero-strength sample set, all direct-reference vectors adapted to the exception path, the v0.4 periodic fixture's invoked normal/exception pairs, 32 low-mantissa binary128 perturbations, one-ULP cutoff proximity and subnormal sigma.
- **40 rejected cases**, comparing exact revert bytes for nonfinite inputs, parameter-domain failures, singular and underflowed squared separation, and arithmetic overflow in both normal and exception modes.
- The **current independent 90-digit scalar-potential differentiation oracle**, unchanged, on all 90 successful cases. Its tolerances remain absolute `1e-30` plus relative `1e-28`; it differentiates the independent energy expression rather than reusing either contract's force implementation.
- Exact deployed runtime versus compiled runtime; internal upstream provenance versus imported source hash; no fake `numericalMath` getter; code size; and measured gas reduction in both benchmark branches.

This is sampled equivalence and direct source review, not an exhaustive equivalence proof over every binary128 input. Oracle tolerances are numerical component checks, not evidence of molecular sampling convergence or predictive affinity accuracy. No original kernel source was changed.

To reproduce with the project's pinned research dependencies available:

```sh
ORVIA_RESEARCH_PYTHON=/path/to/research-environment/bin/python node --test test/inline-nonbonded.test.mjs
```

The Python environment must contain the pinned `mpmath==1.3.0`. The test checks that prerequisite before deploying local contracts. It emits `reports/inline_nonbonded_gas.json` only after all six subchecks complete successfully. Including the parent test, the successful run contains seven Node tests. No RPC URL, wallet key or production signer is used.

## What this means for the workload

For the explicit illustration `N=10,000`, mean within-cutoff neighbors `z=100`, and `1,000,000` steps, there are `5×10¹¹` pair evaluations. Using the inline measured warm-call proxy, the corresponding **pair-only accounting** is:

| Branch assumption | Inline pair-only gas | Days at an explicitly hypothetical sustained dedicated 10⁹ gas/s |
|---|---:|---:|
| Every pair follows the measured below-switch path | 4.01955×10¹⁶ | 465.2 |
| Every pair follows the measured inside-switch path | 5.78185×10¹⁶ | 669.2 |

Those atom, neighbor and step counts are chosen examples, not estimates for a prepared myosin system. The throughput is hypothetical, not measured Robinhood capacity. At a hypothetical `10⁸` gas/s, multiply those times by ten. Actual branch mixtures and input-dependent execution vary. These figures omit the same major work as the original workload report: state reads/writes, integration, other forces, neighbor rebuilds, constraints, alchemical sampling, additional windows/legs/repeats, analysis, transaction overhead and data fees. They are not full-run gas or monetary quotes.

Inlining improves the pair calculation while leaving the scientific and capacity questions open. Whole-simulation percentage savings are smaller when other work remains unchanged. The trajectory comparison described below measures that distinction; it does not justify declaring large on-chain simulations achievable merely by adding contracts or transactions.

## Integration boundary and license

`NeighborDynamicsCoordinator` admits two explicit policies, exposed by its immutable `nonbondedPolicy` getter:

- The original external kernel retains its numerical-math, LJ and Coulomb dependency checks, with an additional expected kernel-identity check.
- The pinned inline policy accepts only the exact runtime of `InlineNonbondedKernel` compiled with the coordinator. It also requires the exact compiled pinned `FloatMath` runtime and matching arithmetic implementation ID for the coordinator's remaining operations. A contract copying the inline identity getters is rejected. The inline kernel exposes no fake external arithmetic-dependency getters.

The existing configuration commitment includes every module address and runtime hash. It therefore binds the selected inline implementation and immutable policy through the coordinator runtime, without changing force ordering, dataset identities, state-page barriers, work limits or the protocol registration schema. Every advancement still checks module and state-page code hashes against the frozen configuration. LJ/Coulomb module addresses remain registered identities for the existing module schema; the inline pair calculation does not call them.

`test/neighbor-dynamics.test.mjs` now compares the same four-atom, three-step trajectory with both kernels, including initial forces and every complete timestep. It also checks arbitrary batching and interrupted drift, namespace isolation, atomic failure rollback, and rejection of copied inline identifiers, an incompatible math runtime and mismatched original dependencies. `reports/neighbor_validation.json` records the resulting full-fixture gas totals and runtime identity; `reports/neighbor_execution_gas.json` retains actual transaction receipts. The comparison measures local advancement, excluding deployment, uploads and registration. It is not a protein-scale workload or a Robinhood fee quote.

The 2026-11-02 targeted run passed all **11 neighbor-suite tests**, with these actual receipts for identical initialization/advancement schedules:

| Four-atom, three-step neighbor NVE fixture | Advancement gas |
|---|---:|
| Original external pair kernel | 66,727,850 |
| Pinned inline pair kernel | 65,446,162 |
| Reduction | **1,281,688 (1.92%)** |

The initial state and all three committed timestep states were bitwise identical, including positions, velocities, forces and potential energy. The **1.92% complete-fixture saving is distinct from the 51–53% pair-only microbenchmark saving**: this fixture also spends gas on bonded/angular forces, geometry, state storage, neighbor preparation, identity checks and transaction overhead. Neither percentage is a measured myosin-system result. The current full validation run must regenerate and bind these reports before release packaging.

This integration supplies no thermostat, constraints, Ewald/PME, alchemical sampling or production data partitioning. It does not raise the 1,024-atom/4,096-step limits, add production slots or clear any scientific/mainnet readiness gate. Standalone kernel equivalence and independent reference checks remain separately required.

**This product includes software developed by ABDK Consulting.** The unchanged upstream source and its BSD-4-Clause copyright notice, conditions and disclaimer remain in `contracts/math/vendor/ABDKMathQuad.sol` and `contracts/math/vendor/LICENSE.md`. Source and binary distributions must retain the applicable notices and acknowledgements; the upstream name is not an endorsement.
