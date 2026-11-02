# Authenticated partitioned inputs, mutable state and retained snapshots

`ShardedWorkingState` removes the old working-page 65,536-word namespace limit by
mapping global word indices to lazily created 4,096-word `VersionedStateShard`
contracts. A namespace can contain up to `2**32 - 1` words, matching the existing
working-page ABI's `uint32` capacity. It does not allocate that entire capacity at
registration. For the production engine's nine-word particle layout, a 100,000-atom
namespace occupies 900,001 addressable words including energy. Addressability is
not evidence that a complete 100,000-atom simulation was run.

Only the immutable, code-hash-pinned writer can create, write, snapshot or seal a
namespace. The router creates every shard itself and records its runtime code hash.
Each access authenticates every touched shard. Direct child writes are rejected.
Reads and writes contain at most 128 words, touch at most two shards, and never scan
earlier shards. Current-word reads use the last stored version directly.

## Snapshot semantics

`snapshotNamespace(sourceNS, snapshotNS)` creates an immutable namespace compatible
with `readWord` and `readWords`. It binds the source name, capacity, exact retained
epoch, ordered word-write digest, router, writer, chain and snapshot name. Reads do
not accept arbitrary epochs. Snapshot-of-snapshot chains are rejected. A word that
is first populated after a checkpoint reads as zero in that earlier checkpoint.

The coordinator must derive the snapshot name from the complete run/step identity
and call this function only after its committed-state barrier. The storage layer
cannot decide whether a molecular timestep is scientifically complete. A test-only
arbitrary writer is not a production authorization model.

Epochs advance only on an authorized snapshot. Repeated force accumulation or
integration writes in the same epoch replace that word's current entry. The first
write after a snapshot preserves the old version and adds a new one. Historical
lookup uses a binary predecessor search with at most 64 rounds because epochs are
`uint64`. Snapshot creation is constant work; retention storage grows with the
number of distinct words modified between retained epochs. It is not free storage
and it does not make repeated snapshots a feasible production sampling policy.

The digest updates per ordered word write, with no batch delimiter, so dividing
the same write sequence into different `writeWords` calls preserves its digest.
It is a commitment to the full ordered execution write history, rather than a
Merkle root of current word values. Different legitimate algorithms can have the
same final values and different write-history commitments.

## Immutable input streams

`PartitionedInputCatalog` registers a stream incrementally using one sealed page
per transaction. Pages contain exactly 4,096 words except the final partial page.
The factory provenance, role, capacity, populated count, digest, code hash and page
order enter the stream commitment. Full coverage must exist before sealing.
The stream has a `uint64` word count, with no sixteen-page admission limit.

`assertStream(streamId)` checks the sealed descriptor in constant work. It does not
scan every page. Actual reads authenticate the touched page's recorded code hash,
irreversible seal, digest and word count. Consequently, corruption of an accessed
page fails closed; an inexpensive descriptor check does not claim that every page
was independently reread. A scientific topology catalog must bind these stream
commitments, roles, schema widths, global atom ordering and complete parameters.

## Evidence and limits

The local tests exercise genuine 65,541-word input data across seventeen pages,
reads crossing page boundaries, immutable retention across twenty checkpoints,
cross-shard real harmonic forces, a `uint64` step counter beyond `2**32`, and the
existing `PagedBondCoordinator` backed by the router with 1,500 actual input atoms.
The 100,000-atom consumer fixture initializes and evaluates only the selected
cross-shard particles; it is a global-index/storage/kernel test, not a complete
large-system force pass or prepared molecular calculation. The old dynamics
coordinators retain their existing admission limits until explicitly migrated.

`reports/sharded_state_gas.json` and `reports/partitioned_input_gas.json` contain
actual local transaction receipts and read estimates. They measure storage and
fixture work under Ganache Shanghai. They exclude a complete Hamiltonian, target
Nitro execution, L1 data fees and physical sampling sufficiency. Full workload
cost must sum model-specific atoms and operations across both legs, each lambda
state and each independent repeat. Complete cardiac-system atom counts remain
unknown until molecular preparation finishes; ligand-only counts or synthetic
100,000-atom addressability must not substitute for those counts.

Read-only target execution can use `eth_call` with code/state overrides, or a
creation call, and `debug_traceCall` when the provider enables it. A successful
call would demonstrate execution by that target RPC backend at a pinned block;
it would not deploy the contracts or persist a run. Method availability and exact
Nitro behavior require actual target evidence. References: [Geth eth namespace](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth),
[Geth debug namespace](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug),
[Robinhood Nitro node instructions](https://docs.robinhood.com/chain/run-a-full-node/).
