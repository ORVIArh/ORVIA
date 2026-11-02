# Resumable execution component

This document describes the original v0.1 fixture retained for regression testing. The v0.2 paged harmonic implementation is documented in [PAGED_EXECUTION.md](PAGED_EXECUTION.md), and the v0.3 moving-state implementation in [DYNAMICS_EXECUTION.md](DYNAMICS_EXECUTION.md). The repository now contains sixteen experimental component types.

Status: implemented component-validation slice. This code accumulates harmonic-bond energy and forces at fixed coordinates. It does not run an integration timestep, protein simulation, solvent calculation, alchemical ensemble, or binding free-energy analysis.

## Current deployable contracts

The core lane supplies three contracts:

- `ExperimentRegistry`: append-only registrations containing the specification digest and ordered numerical-module addresses/code hashes.
- `DataPage`: bounded immutable-input words uploaded in transactions and irreversibly sealed. It is not a mutable working-state page.
- `ResumableBondEngine`: immutable molecular inputs per run, permissionless bounded work, persistent energy/force accumulators, and a deterministic cursor.

The numerical lane supplies `FloatMath` and `HarmonicBondKernel`. `ABDKMathQuad` is compiled into `FloatMath`; its source presence does not imply an additional deployment. This component therefore has five deployable contracts, not the complete planned 64-contract system. The input page is tested independently; the engine currently copies operands directly into its own storage and does not read molecular operands from `DataPage`.

## Deployment and registration API

1. Deploy `ExperimentRegistry(owner)`.
2. Deploy `FloatMath()` and `HarmonicBondKernel(floatMathAddress)`.
3. Deploy `ResumableBondEngine(owner, floatMathAddress, kernelAddress, registryAddress)`.
4. Register a protocol using `registerProtocol(protocolId, specificationHash, modules)`, with at least the math, kernel **and engine** addresses in `modules`. Extra modules can be recorded, up to 64 total. Duplicate and empty-code addresses are rejected.
5. Register a run using `registerExperiment(protocolId, positions, bonds)` from `owner`. Registration atomically validates and copies all operands; there is no subsequent input-edit or protocol-update method.

Each position is `bytes16[3]` holding IEEE binary128 x/y/z values. A bond tuple is `(uint32 a, uint32 b, bytes16 k, bytes16 r0)` with zero-based atom indices. The kernel units are whatever internally consistent units the committed test protocol declares; the intended molecular convention is nm and kJ/mol, making k a value in kJ/mol/nm².

Run IDs start at 1. The present fixture limits are 2–128 atoms and 1–256 bonds. These are limits of this validation component, not a reduced scientific specification for ORVIA-001. Large protein inputs need the separately planned paged input/run architecture.

`protocolId`, `specificationHash`, and module addresses are fixed at registration. The metadata digest alone is not full scientific-input storage; the production registry must bind sealed on-chain protocol/data pages. For this component all numerical operands that affect its result are stored explicitly in the engine.

## Advancing a run

`advanceExperiment(runId, workLimit)` is callable by any account. `workLimit` is 1–16 bonds. The contract determines which bonds are next; callers cannot choose individual interactions, skip work, replace parameters, or inject results.

For each bond in ascending input order, the engine calls the registered kernel and accumulates:

\[
U = \frac12 k(r-r_0)^2,\qquad
\mathbf F_A = k(r-r_0)\frac{\mathbf r_B-\mathbf r_A}{r},\qquad
\mathbf F_B = -\mathbf F_A.
\]

Coordinates are never modified during this accumulation. Work split across transactions has the same floating-point accumulation order as work completed in a single call. Numerical results are expected to be byte-for-byte identical for the same operands, not merely approximately close, when only batch boundaries change.

The method returns `(processed, completed)`. Each successful call processes at least one bond. After the last bond it changes status to `Completed`; further advancement reverts.

Status values are:

| Value | Status |
|---:|---|
| 0 | Missing |
| 1 | Ready |
| 2 | Running |
| 3 | Completed |

Inputs reject non-finite values, out-of-range/self-referencing atom indices, and negative nonzero force constants or equilibrium lengths. Distinct atoms at coincident coordinates can be registered; the kernel detects the singular geometry during advancement and reverts. This permits explicit transactional-failure testing. Any failed call rolls back the whole current transaction, including completed bonds earlier in that same call; it preserves checkpoints from earlier successful transactions.

Module code hashes are checked on run creation and each advancement. The current modules use immutable dependency addresses and no proxy pattern. A code hash alone cannot generally detect changes in storage behind an upgradeable proxy; the present immutability claim relies on these specific deployed module implementations as well as their hashes.

## Reading outputs

`runInfo(runId)` returns:

`(protocolId, inputHash, commitment, cursor, bondCount, atomCount, status, totalEnergy)`.

`positionAt(runId, index)`, `forceAt(runId, index)`, and `bondAt(runId, index)` expose the stored operands/accumulators. `ExperimentRegistered` and `ExperimentAdvanced` events supply progress, but the authoritative state is contract storage.

The run commitment binds the domain tag, chain ID, engine address, run ID, protocol manifest hash, complete encoded molecular input, and numerical/registry addresses and code hashes. Different runs intentionally have different commitments even when their operands match; batching-invariance tests compare their actual energies, forces, cursor and completion state.

## Input page API and commitment

`DataPage(owner, role, capacityWords)` accepts capacities 1–4096, with `append(bytes32[])` limited to 1–128 words per transaction. Only its immutable owner can append or seal. Reads are permissionless.

The digest is defined exactly as:

```text
d0 = keccak256(abi.encode(bytes32("ORVIA-DATA-PAGE-v1"), role, uint32(capacityWords)))
d(i+1) = keccak256(abi.encode(d(i), word(i)))
```

It is an ordered, domain-separated page commitment. It is not SHA-256 of the original source file and not keccak256 of a concatenated file. Fixed word boundaries must be specified when importing files. Transaction batch boundaries do not affect the digest.

`seal(expectedDigest)` verifies the current digest and rejects an empty page. Sealing is irreversible. Getters are `wordCount()`, `readWord(index)` and `readWords(start,count)` (count ≤128), plus the public metadata fields.

## Evidence still required

The root integration tests must compile the current contracts, execute transactions on a local EVM, compare against independent analytical/Decimal reference vectors, compare multiple batch partitions byte-for-byte, verify equal/opposite force conservation, and test permissions, bounds, freezing and full transaction rollback. Only reports from completed tests establish which checks passed.

Mainnet RPC configuration, source-code compilation, and local EVM transactions are different forms of evidence. This component performs no mainnet deployment. No token, swap hook, router, production system preparation, molecular-dynamics trajectory, or cardiac therapeutic claim is included.
