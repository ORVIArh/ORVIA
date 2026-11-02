# ORVIA research log

Entries distinguish measured work, proposals and unresolved questions. Numerical component tests are not a binding-affinity prediction or biological validation.

## 2 November 2026 — recovered baseline

- Recovered `ORVIA-v0.5.0-source-and-validation.zip` from the project's saved Library artifact.
- Archive SHA-256: `99a01e5529223eb653d224d8cf8949917b9a89620b2e842cd4dd7dfc2f0b4659`.
- All **256 payload files** matched `reports/package_checksums.json`. The archived source-bound validation verifier passed before new work.
- Baseline records 44 experimental deployable contract types, 205 passing Node/EVM tests, 63 passing Python references and nine passing check groups. These are the archived run's results, completed at `2026-11-01T20:38:21.755Z`.
- Fresh independent Python reference execution reproduced **63 passes** on CPython 3.12.14 with the pinned research dependencies. The isolated baseline full rerun was stopped to run the final changed source once; it is retained as incomplete and is not a new 205-pass claim.

## 2 November 2026 — v0.5.1 engineering and preparation

- Added explicit inline-kernel admission to neighbor NVE, with exact runtime/provenance checks, existing protocol/code commitments, trajectory equivalence, interruption/partition and rollback tests. The standalone force implementation and Hamiltonian are unchanged. [Method and measured results](docs/COMPUTE_COST.md).
- The targeted neighbor suite passed **11/11 tests**, without failures, skips or cancellations. Original and inline execution produced bitwise-identical initial forces and all three committed timestep states. The same four-atom initialization/advancement schedule used **66,727,850 gas** with the original pair kernel and **65,446,162 gas** with the inline kernel: **1,281,688 gas (1.92%) saved**. These local advancement totals exclude deployment, uploads and registration. The standalone pair-only 51–53% saving is a different measurement; neither is full-myosin or mainnet fee evidence.
- Confirmed read-only Robinhood mainnet chain ID **4663** through the Pinax endpoint listed in the [official connection documentation](https://docs.robinhood.com/chain/connecting/). The official public endpoint remains unavailable in the recorded probe. [Preflight evidence](reports/mainnet_preflight.json).
- Added a source- and block-pinned local state-fork smoke runner with an upstream read-only allowlist. [Scope and evidence](docs/FORK_SMOKE.md). This uses a local Ethereum simulator and does not clear production target-execution acceptance.
- Extended the alternative public-model audit: the first 29,544 topology/PDB atom identities match, followed by five Mg/acetate identity mismatches. Truncating the larger PDB to topology length cannot produce a valid paired model. The 47 selected cofactor atoms match identities, and CHAMBER charge decoding recovers ADP3−, Mg2+ and H2PO4−. [Audit and limits](data/prepared_candidate/alternative_models/README.md).
- Recorded a separately named, **unapproved** [ADP/phosphate candidate protocol](docs/PROPOSED_ADPPI_PROTOCOL_v0_1.md). The original vanadate experiment and its failed readiness status remain unchanged.
- Current full-suite outcome is recorded only in [validation_summary.json](reports/validation_summary.json). A checkpoint with an incomplete or failed summary must not be described as fully validated.

## 2 November 2026 — supplementary target-node execution

A separately packaged read-only probe source-compiled two kernels and executed contract creation and exact scalar/pair calls through the Robinhood provider at pinned block `0x6322b6e`. All runtime and numerical bytes matched; all 14 remote requests used the hardcoded read-method allowlist. Zero transactions were sent. The portable harness/report/manifest companion is outside the offline complete suite. [Methods, trust and limitations](docs/TARGET_NODE_EXECUTION.md). This does not clear full-system, transaction, gas or scientific acceptance.

## 2 November 2026 — complete v0.5.1 validation

The complete v0.5.1 run finished at `2026-11-02T04:59:25.175Z`: **212 Node/EVM tests and 63 Python reference tests passed**, with zero failed, cancelled or skipped Node tests. All nine check groups and the final integrity verifier passed. The summary binds 159 input files, two compiler outputs, 36 regenerated reports and nine logs. Mainnet readiness remains false.

## Open questions

The original experiment lacks complete reviewed molecular systems and a single full-system sampling pipeline. No drug-binding free-energy result has been produced. Actual full-run cost and duration remain unmeasured. All 64 production instances remain planned; mainnet readiness is false.
