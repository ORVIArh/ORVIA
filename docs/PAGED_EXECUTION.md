# Paged harmonic-force execution

`PagedBondCoordinator` connects `DatasetCatalog` input streams to a writer-restricted `WorkingStatePage`. Coordinates and bond parameters remain in sealed input pages; energy and forces live in experiment-specific output namespaces. No numerical result is supplied by the transaction caller.

This is a paged harmonic-force component. It has no integration timestep, moving coordinates, solvent dynamics or free-energy estimator. The standalone Lennard–Jones and Coulomb kernels are tested independently and are not yet part of its accumulation loop.

## Configure once

1. Deploy `ExperimentRegistry(owner)`, `FloatMath()`, `HarmonicBondKernel(math)` and `DatasetCatalog(owner)`.
2. Deploy `PagedBondCoordinator(owner, math, kernel, registry, catalog)`.
3. Deploy `WorkingStatePage(coordinator)` and call `coordinator.bindWorkingPage(page)` as owner. Binding can happen only once; the page's immutable writer must equal the coordinator address.
4. Register a protocol containing the math, kernel, catalog, working page and coordinator addresses. The registry itself is separately pinned in the coordinator configuration.
5. Use the catalog factory to create position/bond pages, upload the numerical words, seal them, and register their ordered lists. The exact schema and commitment are in [PAGED_DATA.md](PAGED_DATA.md).
6. Call `registerExperiment(protocolId, datasetId)` as owner. The coordinator pins the dataset commitment and creates a fresh, zero-initialized output namespace. Inputs are validated in later bounded transactions.

No experiment can advance before working-page configuration. Dependencies and protocol membership are checked at registration and every advancement. The supplied implementations have no proxy upgrade path. Code-hash checks do not make arbitrary storage-backed proxy dependencies immutable.

## Advancement stages

Anyone can call `advanceExperiment(experimentId, workLimit)` with `workLimit` from 1 to 16. One work unit processes one atom or one bond, according to the current stage. The caller cannot select individual records or overwrite results.

| Status value | Stage | One work unit | Transition |
|---:|---|---|---|
| 0 | Missing | No valid run | Reads/advancement reject |
| 1 | ValidatingAtoms | Read three canonical finite coordinates | All atoms checked → status 2, cursor 0 |
| 2 | ValidatingBonds | Read and validate both indices, k and r0 | All bonds checked → status 3, cursor 0 |
| 3 | Running | Evaluate one harmonic interaction and accumulate energy/forces | Last bond → seal output namespace, status 4 |
| 4 | Completed | No further work allowed | Immutable completed outputs |

A transaction can cross stage boundaries if work remains in its budget. All atoms and bond records are validated before the first force is calculated. Singular pair geometry and arithmetic overflow are detected during evaluation; these are not claimed to have been excluded by earlier parameter validation.

Within a transaction, any failure reverts the cursor, phase and every working-page write. Earlier successful transactions remain committed. Thus a singular later bond can leave an incomplete run with valid earlier force contributions; it cannot produce a completed or sealed result. A retry uses the same unchanged inputs and next record.

Transaction partitions preserve the operation order. Changing sender, batch size or elapsed wall-clock time does not change the calculation. There is no scientific randomness in this component.

## State layout and public reads

Each run receives `3 * atomCount + 1` words. Force component `axis` of atom `i` is at `3*i + axis`; total energy is at `3*atomCount`. All numerical bit patterns occupy the low 128 bits of each word. Only this coordinator can write its working page, and completed namespaces cannot be written again.

`runInfo(id)` returns `(protocolId, datasetId, commitment, stateNamespace, cursor, atomCount, bondCount, status, totalEnergy)`. `positionAt(id, atom)` reads the sealed catalog inputs; `forceAt(id, atom)` reads the output page. The page API also permits direct namespace reads.

Run IDs start at one. A namespace is `keccak256(abi.encode(bytes32("ORVIA-PAGED-STATE-v1"), uint256(chainId), address(coordinator), uint256(runId)))`. Different experiments cannot share the same namespace through this API.

## Commitment

The immutable core configuration hash binds the ordered addresses and runtime code hashes of math, harmonic kernel, registry and catalog. The one-time configuration hash additionally binds the working-page address and runtime code hash:

```text
core = keccak256(abi.encode(math, mathHash, kernel, kernelHash,
                            registry, registryHash, catalog, catalogHash))
configuration = keccak256(abi.encode(core, pageAddress, pageCodeHash))
run = keccak256(abi.encode(
    bytes32("ORVIA-PAGED-BOND-v1"), uint256(chainId), address(coordinator),
    uint256(runId), bytes32(protocolManifest), bytes32(datasetId),
    bytes32(datasetCommitment), bytes32(configuration), bytes32(stateNamespace)
))
```

The actual molecular operands remain readable on-chain. These hashes bind their identities and the computation; they do not replace the operands or establish physical validity.

## Limits and evidence

This schema supports 2–4,096 atoms, 1–16,384 bonds and at most 16 pages in each input stream, with existing `DataPage` capacities. These are bounded development-component limits, not an adequate specification for the eventual solvated myosin calculation. Full molecular schemas, integrator state and complete force-field coverage remain unfinished.

`test/paged.test.mjs` covers cross-page records, validation barriers, phase crossing, original-engine equivalence, partition invariance, namespace isolation, malformed inputs and rollback across contracts. `reports/validation_summary.json` and its logs record the completed integrated check results. Local gas measurements, when present, apply only to those fixtures.
