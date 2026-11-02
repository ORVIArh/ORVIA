# Fixed-bank working state

`BankedWorkingState` is a new storage candidate for the full on-chain molecular
pipeline. It keeps the mutable/snapshot consumer ABI of `ShardedWorkingState`
while sharing a fixed pool across every logical page, namespace, run and retained
epoch. The original sharded implementation is unchanged.

The constructor is `BankedWorkingState(writer, bankCount)`, with an immutable
contract writer and an immutable count from 1 to 128. It creates no banks. Anyone
may call `deployBanks(work)` to create the next one to four predetermined banks.
Provisioning stops at the configured count; callers cannot register replacement
code, increase the pool or choose a different bank address. Each bank is created
by the router with the same fixed creation code and router argument. The router
records and checks its runtime code hash on every touched-bank access.

For the proposed two-writer pipeline, 64 banks for simulation state and 64 for
Hamiltonian outputs mean **128 banks plus two routers: 130 actual addresses**.
These routers and every bank must be included in the complete deployment
inventory. Control, compute, input and analysis contracts are additional. This
module does not assert that a complete 256-address release is implemented or
scientifically accepted.

## Routing and bounded work

```text
logical_page = global_word_index / 4096
bank_index = logical_page % immutable_bank_count
stored_key = (mutable_source_namespace, global_word_index)
```

The full global index remains in the key. Reusing a bank for page 0 and page 128
does not reuse their word locations, and different namespaces do not share values
or histories. Namespace capacity remains a positive `uint32` word count. A batch
contains at most 128 words and is split only at 4,096-word logical boundaries,
touching at most two banks with constant-time addressing. It never scans preceding
pages or namespaces.

Reads from an unprovisioned bank return zero: no authorized write could previously
have populated it. Writes to an unprovisioned bank revert. Provisioning is never
hidden in a namespace, write, seal or snapshot operation. A later-bank failure
rolls back earlier bank writes and the router's digest in the same transaction.

`shardInfo(namespace, logicalPage)` remains available for compatibility metadata;
it returns the page's shared bank address and pinned hash. A bank can therefore
appear in several logical-page entries even when those pages have never been
written. `bankInfo(index)`, `bankCount()` and `deployedBankCount()` report the actual
fixed pool directly.

## Identity and retained state

Mutations require both the immutable writer address and its captured runtime code
hash. A bank accepts calls only from its immutable router with its captured runtime
code hash. Bank history is keyed
by the original mutable namespace and global word index. Repeated writes in one
epoch replace the latest version; the first write in a later epoch retains the
previous value. Historical predecessor lookup takes at most 64 binary-search
rounds, bounded by strictly increasing `uint64` epochs. Current-word lookup uses
the last version directly.

The ordered write digest includes every word write, including overwrites, without
batch delimiters. The same ordered writes split into different batches yield
identical digests and snapshot commitments. This is a write-history commitment,
not a Merkle root of final values. The banked identity domain binds the router,
writer/code hash, fixed bank count and namespace. Its commitments intentionally
differ from the original sharded identity domain.

Snapshots retain the exact source namespace, epoch, capacity, write digest and
commitment. They are sealed, cannot become snapshot sources, and resolve words
first written after the retained epoch to zero. The scientific writer must derive
snapshot names from run/step identity and invoke snapshot creation at a complete
state barrier; the storage layer does not decide molecular completeness. Retained
history still grows with modified words and checkpoints. A fixed address count
does not cap storage growth or make full sampling inexpensive.

## Focused evidence

Run from the repository root:

```sh
node --test test/banked-state.test.mjs
```

The test compiles its exact dependency graph in memory using Solidity 0.8.26,
optimizer 200 and Shanghai rules. It leaves shared build artifacts and compile
reports untouched and writes only `reports/banked_state_validation.json`.

The initial focused run passed five Node tests including its parent, without
failures or skips. It actually provisioned 128 unique banks, verified their
CREATE2 addresses and code hashes, and checked that many additional namespaces,
logical pages, writes and snapshots did not create more child contracts. It
covered the largest valid word index 4,294,967,294, wraparound bank reuse,
cross-namespace isolation, twenty retained epochs, exact partitioned commitments,
unauthorized bank access, changed writer/router/bank runtimes and transactional rollback.

An existing consumer compiled against the old `ShardedWorkingState` type computed
real harmonic forces using the banked router, including an atom whose state
crosses a logical boundary and atom 132,935, with checkpoints beyond `2**32`
steps. This fixture evaluates two selected particles in a 132,936-atom address
space; it is not a complete large-system force pass. The full molecular
Hamiltonian/pipeline binding and complete prepared-system validation remain
separate integration work.

The captured local receipts measured:

| Operation | Local receipt gas |
|---|---:|
| Router deployment, no banks | 2,096,546 |
| All 128 banks, 33 bounded provisioning calls | 70,490,352 |
| First bank alone | 609,142 |
| Representative four-bank provisioning call | 2,200,753 |
| Cold 128-word write across two logical pages | 8,779,683 |
| Immutable checkpoint | 127,009 |
| Selected real harmonic force at large global indices | 603,773 |

The historical read estimate after twenty epochs was 60,863 gas. These are local
Shanghai fixture measurements, not Robinhood transaction receipts, a full-model
cost, a throughput claim or a demonstrated production speedup. No wallet or target
transaction is used. The report binds exact source/compiler/test hashes and keeps
the scientific scope explicit.
