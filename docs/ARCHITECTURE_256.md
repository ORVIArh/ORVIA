# ORVIA-256: full on-chain molecular execution

The active target is 256 actual contracts on Robinhood mainnet, including every factory-created storage contract. Molecular production forces, integration, sampling, cross-state energies and analysis remain on-chain. GPU work supports preparation, independent references and workload measurement. There is no fixed dollar cap. No target-chain contract has been deployed.

The [machine-readable inventory](../data/architecture_256.json) contains the implemented local inventory and explicitly unfinished production responsibilities:

| Group | Actual addresses in the target |
|---|---:|
| Core modules and routers | 32 |
| Immutable molecular input banks | 96 |
| Pipeline state and retained-epoch banks | 64 |
| Hamiltonian force/energy output banks | 64 |
| **Total** | **256** |

The [complete local prototype](COMPLETE_256_PROTOTYPE.md) now deploys **256 distinct actual addresses** and verifies that molecular work creates no additional contracts. Thirty-one core components participate in the molecular and analysis paths. The remaining core component is a functional, independently validated raw `C4PairKernel`, exercised separately; its alchemical composition is still unaccepted. There are no empty placeholder deployments. Deploying the complete inventory does not make the full prepared Hamiltonian scientifically complete.

The old storage design created one child address per 4,096-word page and per mutable namespace. At 132,936 hybrid atoms, a single nine-word-per-atom state needs 293 such pages; its force/energy output needs another 98. The matched solvent leg requires 333 and 111 respectively. Those 835 children already exceed 256 before input pages or core modules. The new design must eliminate that unbounded address creation.

## Fixed bank pools

`BankedInputCatalog` uses 96 input banks across all streams. `BankedWorkingState` has an immutable configured pool size; the target uses two separate 64-bank pools because the pipeline and Hamiltonian have different immutable writers. A global word index determines its bank in constant work. The original stream/namespace identity and full global index remain in each stored key, so successive logical pages can share one bank without aliasing.

Pools are provisioned in bounded batches, and no data upload, namespace creation, timestep or snapshot may create another address. Routers authenticate bank runtime hashes and enforce ownership, full input coverage, irreversible input sealing and retained-epoch semantics. Read/write batches remain bounded. Logical pages and retained samples grow the state inside those fixed addresses; they do not increase the contract count. Storage growth and gas still require explicit measurement.

## Integration and acceptance

The full-model topology must retain every atom, supported force-field term, exclusion and exception. The present native candidates contain 132,935 complex atoms and 151,505 matched solvent atoms; the hybrid adds one ghost atom per leg. Model quality gates remain unaccepted. Finite direct Ewald is the current numerical candidate; PME is not implemented or claimed. Production electrostatics must satisfy a predeclared, measured error budget for the complete model.

Fixed-bank storage, authenticated constrained substeps, ordered spatial traversal and preregistered analysis now have connected small-fixture evidence. The spatial Hamiltonian preserves ordered energy/force results and falls back to all pairs outside its proven numerical domain. It does not change production into an off-chain result-attestation system. A larger contract inventory alone does not reduce the number of molecular interactions.

Before mainnet: complete and validate C4 ghost activity, alchemical coupling and long-range energies; validate the full prepared Hamiltonian and required constraints; establish accepted scientific inputs and a registered sampling schedule; run current-source full integration/security checks; measure complete target execution and fees; and prepare a reviewed, source-bound deployment plan. The legacy 64-slot readiness tool remains insufficient for this new architecture and must fail closed during migration.

## Current 256-contract checkpoint

The [source-bound integration report](../reports/complete_256_validation.json) covers all 32 core contracts and 224 banks, owner/configuration-freeze checks, three preregistered repeat pairs, a constrained step and sample through the spatial Hamiltonian, and one two-state campaign through chronology, selection, MBAR and accepted overlap/ESS diagnostics. It does not claim that all three repeat pairs finished or that the full model ran. Separate repeat-uncertainty and stochastic-constraint tests retain their own exact source provenance.

Local creation receipts total **183,998,164 gas**: 73,300,040 for core deployment and 110,698,124 for bank creation. This excludes bindings, registration, full input upload and campaign work, and is not a Robinhood fee quote. The [target-provider creation probe](TARGET_256_CREATION_PROBE.md) returned exact 40,945-byte pipeline and 34,449-byte Hamiltonian runtimes through read-only calls, without persistent deployment.

## Historical first connected checkpoint

The [local integration report](../reports/banked_molecular_pipeline_validation.json) records **248 distinct local contract addresses**: 24 connected core contracts and all 224 fixed banks. The test verifies every bank runtime hash and confirms that uploading inputs, retaining snapshots, producing a trajectory and recording cross-state energies create no further contracts. A two-atom fixture matches the legacy storage path bit for bit in its initial/final states and all eight retained cross-state energy values despite different transaction partitions. This is a connected storage regression, not a full molecular-model run or complete 256-contract deployment.

Measured local deployment gas is 51,575,338 for the 24 core contracts plus 110,698,124 for bank creation: **162,273,462 gas**. The two-atom pipeline advancement measured another 81,935,397 gas. These are Ganache execution receipts, excluding complete model loading, missing core integrations and target-specific execution/L1 data allocation. They are not final mainnet fee quotes.

Reproduce the allocation check and connected test with `python3 scripts/validate_architecture256.py` and `node --test test/banked-molecular-pipeline.test.mjs`. The allocation checker now verifies the 256-address inventory, report binding and current compiled source hashes. The full-system readiness gate still rejects this development checkpoint.
