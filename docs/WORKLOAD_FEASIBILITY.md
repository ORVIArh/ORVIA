# ORVIA workload feasibility — measured local pair work

The current arithmetic is measurable, but full-protein, repeated alchemical simulation is **not demonstrated feasible or mainnet-ready**. A favorable warm evaluation of one charged, nonzero pair uses **172,630 local EVM gas below the switch** or **237,459 inside the switch**. Full dynamics also needs coordinate/force storage, other forces, integration and sampling. Deploying more contracts does not reduce this total work.

These are measurements of the current **quintic-switched Lennard-Jones plus conducting reaction-field** implementation. That electrostatics model is not Ewald/PME. Its measured gas is useful evidence about the present binary128 numerical architecture, not a substitute estimate for a different completed RBFE force path.

## Reproduce and inspect

Run from the project root:

```sh
node scripts/workload.mjs
```

The script compiles only the exact pair kernel, its dependencies and the test-only `PairWorkMeter` in memory. It creates an isolated Ganache chain with chain ID 31337, Shanghai gas rules, solc 0.8.26 and optimizer 200. It never accepts an RPC URL, private key or production signer. It writes `reports/workload_feasibility.json` with source hashes, compiler settings, local runtime hashes, transaction hashes, inputs, outputs and all 24 numerical scenarios. It does not overwrite the project's main compilation artifacts.

Ten actual transactions measure 0, 1, 2, 4 and 8 evaluations in each branch. Every emitted result digest is reconstructed independently from direct kernel output; baseline, positive gas, warmed calls and receipt-slope relationships are asserted. The meter has no production role and must not count toward deployed application instances.

The input parameters are exact binary128 dyadic values: sigma 0.5, epsilon 0.125, charge product −0.25, prefactor 1, switch distance 2 and cutoff 3. Displacements are `(1, 0.25, 0.125)` below the switch and `(2.5, 0.25, 0.125)` inside it. All three coordinates, charge interaction and LJ strength are nonzero. These are numerical benchmark cases, not a force-field parameter set or prepared molecule.

## Actual gas measurements

| Pair evaluations | Below switch: receipt gas | Inside switch: receipt gas | Below switch: fixed-overhead-subtracted execution gas | Inside switch: fixed-overhead-subtracted execution gas |
|---:|---:|---:|---:|---:|
| 0 | 26,482 | 26,484 | 0 | 0 |
| 1 | 207,445 | 272,276 | 180,951 | 245,780 |
| 2 | 380,898 | 510,558 | 354,404 | 484,062 |
| 4 | 727,804 | 987,122 | 701,310 | 960,626 |
| 8 | 1,421,626 | 1,940,260 | 1,395,132 | 1,913,764 |

For each transaction, the script removes intrinsic gas `21000 + 4*zero_calldata_bytes + 16*nonzero_calldata_bytes` before subtracting that branch's zero-pair execution baseline. This avoids attributing the 12-gas change from a zero count byte to pair computation. The zero-pair execution baselines are 5,162 and 5,152 gas.

Positive-count slopes cancel the fixed event/dispatch baseline and the first-call cold-account cost:

| Measurement | Below switch | Inside switch |
|---|---:|---:|
| Receipt marginal gas, 1→2 pairs | 173,453 | 238,282 |
| Receipt marginal gas, 2→4 pairs | 173,453 | 238,282 |
| Receipt marginal gas, 4→8 pairs | 173,455.5 | 238,284.5 |
| First measured external call | 180,130 | 244,959 |
| Warm calls 2–8: range | 172,630–172,634 | 237,459–237,463 |
| Favorable warm-call proxy used below | **172,630** | **237,459** |

The `gasleft()` interval includes kernel input validation, arithmetic, dependency calls, call/return marshalling and a small measurement-instruction overhead. It excludes the checksum, event, outer loop control and transaction intrinsic gas. Receipt slopes additionally contain those per-iteration meter operations. Small variation across warm calls reflects memory growth. Repeating identical inputs deliberately favors warm account locality; it is not a varied trajectory or worst-case benchmark.

The tables use a **conditional partial-work lower-bound accounting proxy**: the favorable measured warm-call cost times the requested number of pair evaluations. This is not a mathematical lower bound for arbitrary inputs, zero-strength shortcuts, another algorithm, optimized code or Robinhood's unverified execution schedule. The large positive parts of a complete simulation listed below are omitted.

## Transparent scaling assumptions

For `N` atoms with average symmetric **within-cutoff** neighbor count `z`, counting each unordered pair once:

```text
pairs_per_step = N * z / 2
steps = ceil(T / dt)                 # T and dt in the same units
pair_evaluations = pairs_per_step * steps
partial_pair_gas = pair_evaluations * measured_warm_pair_gas
```

The illustrations specify steps directly. They do not assert that either step count is sufficient for equilibration or accepted free-energy sampling. They assume one pair-force evaluation per integration step; initialization and additional evaluations add work. The neighbor count omits out-of-cutoff candidates within a Verlet skin, exceptions and rebuild screening.

| Atoms N | Neighbors z | Pairs per step | Pair evaluations for 1,000 steps | Pair gas for 1,000 steps, below/inside switch | Pair gas for 1,000,000 steps, below/inside switch |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 100 | 50,000 | 50,000,000 | 8.6315×10¹² / 1.187295×10¹³ | 8.6315×10¹⁵ / 1.187295×10¹⁶ |
| 1,000 | 500 | 250,000 | 250,000,000 | 4.31575×10¹³ / 5.936475×10¹³ | 4.31575×10¹⁶ / 5.936475×10¹⁶ |
| 10,000 | 100 | 500,000 | 500,000,000 | 8.6315×10¹³ / 1.187295×10¹⁴ | 8.6315×10¹⁶ / 1.187295×10¹⁷ |
| 10,000 | 500 | 2,500,000 | 2,500,000,000 | 4.31575×10¹⁴ / 5.936475×10¹⁴ | 4.31575×10¹⁷ / 5.936475×10¹⁷ |
| 100,000 | 100 | 5,000,000 | 5,000,000,000 | 8.6315×10¹⁴ / 1.187295×10¹⁵ | 8.6315×10¹⁷ / 1.187295×10¹⁸ |
| 100,000 | 500 | 25,000,000 | 25,000,000,000 | 4.31575×10¹⁵ / 5.936475×10¹⁵ | 4.31575×10¹⁸ / 5.936475×10¹⁸ |

**All atom counts, neighbor counts and step counts above are chosen illustrations. None is an estimate for the unprepared myosin model.** The 1,000,000-step cases have exactly 1,000 times the work of the corresponding 1,000-step cases. The JSON records integer gas totals without rounding.

For a real campaign, sum work across each complex/solvent system, lambda window and repeat. If all systems happened to have the same workload, the simplified multiplier would be `legs * lambda_states * replicas`. Actual complex and solvent systems generally need their own `N`, `z` and step count; cross-state sample-energy evaluations are additional. No particular campaign multiplier is assumed here.

## Hypothetical time, without assuming Robinhood throughput

The public-RPC preflight recorded HTTP 403. It provides **no sustained gas-throughput measurement**. Neither the 30-million local block limit nor a documented code-size limit establishes Robinhood throughput or an available application allocation.

The following is dimensional arithmetic only: `time = partial_pair_gas / hypothetical_sustained_dedicated_gas_per_second`. It assumes the entire stated rate is continuously available to this application, without competition or interruptions. Both rates are explicitly hypothetical, not network facts or forecasts.

| Illustration, each 1,000,000 steps | At hypothetical 10⁹ gas/s: days, below/inside switch | At hypothetical 10⁸ gas/s: days, below/inside switch |
|---|---:|---:|
| N=1,000, z=100 | 99.9 / 137.4 | 999.0 / 1,374.2 |
| N=1,000, z=500 | 499.5 / 687.1 | 4,995.1 / 6,870.9 |
| N=10,000, z=100 | 999.0 / 1,374.2 | 9,990.2 / 13,741.8 |
| N=10,000, z=500 | 4,995.1 / 6,870.9 | 49,950.8 / 68,709.2 |
| N=100,000, z=100 | 9,990.2 / 13,741.8 | 99,901.6 / 137,418.4 |
| N=100,000, z=500 | 49,950.8 / 68,709.2 | 499,508.1 / 687,092.0 |

For the 1,000-step cases, divide these times by 1,000. No gas price, ETH total or dollar quote is inferred.

## Work omitted and current implementation limits

This accounting excludes bonded forces; constraints; periodic nearest-image geometry; pair-parameter mixing; neighbor-list construction and rebuilds; exclusions and skin candidates; Ewald/PME real and reciprocal work; coordinate, velocity and force reads/writes; integrity checks and dispatch; integration, thermostat and randomness; input upload and deployment; equilibration; all-state alchemical energy evaluations; MBAR, diagnostics and repeat uncertainty; and transaction/data fees.

Current `NeighborDynamicsCoordinator` and `LangevinDynamicsCoordinator` caps are **1,024 atoms and 4,096 steps**, with at most eight work units per `advance`. The report hashes the source files establishing these caps. Larger table scenarios are therefore extrapolations that these coordinators reject. Passing those two count checks alone does not make a scenario scientifically prepared or executable. Raising constants alone would not establish scalability.

The current `NeighborList` rebuild explicitly screens `N*(N−1)/2` unordered pairs. Reuse can avoid repeated full screening, but the present rebuild is still quadratic in atom count; it is not a spatial cell-list implementation. The projection's `N*z/2` force count does not include that rebuild work. This statement is derived directly from `NeighborList.advance` and `_screen`, not from an assumption about another MD package.

Permissionless transactions can advance a finite, resumable job. More instances or callers do not remove the work per pair, timestep dependencies, repeated simulations, state writes or finite chain execution capacity. These measurements show that current full-protein RBFE readiness needs a concrete prepared protocol, a completed force/sampling path, major measured throughput improvements where possible, and a demonstrated acceptable schedule on the actual target network. They do not establish that arbitrary large workloads eventually finish within an acceptable duration.

Primary EVM references for the measurement interpretation: [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929) specifies transaction-scoped cold/warm account access; [EIP-2028](https://eips.ethereum.org/EIPS/eip-2028) specifies the nonzero calldata byte gas change. Measurements and formulas in this document come from the local code and report. Neither EIP asserts Robinhood's current capacity.
