# Canonical traversal of cell candidates

`OrderedNeighborPairs` is a new bounded consumer of `PeriodicCellIndex`. It is not
yet connected to `AlchemicalHamiltonianEvaluator`. It occupies one planned compute
role and creates no child contracts, pages, per-run contracts or persistent pair
arrays. This component does not establish a full molecular speedup.

The constructor pins an immutable contract owner and its runtime hash, and one
cell-index instance/runtime. The intended production owner is the Hamiltonian
evaluator. Only that owner can register a traversal or consume its cursor. The
test owner is an explicitly unrestricted harness, not a production authorization
model. The deployment/protocol must bind the actual reviewed index source/runtime;
a matching policy getter alone is not source verification.

Registration accepts only an already complete authenticated on-chain index ID.
Its source/index commitment and atom count enter the traversal commitment. A
caller cannot provide candidate pairs, cell heads, a replacement source frame,
arbitrary traversal cursors or a selected partner sequence.

For each atom `i` in increasing order, the iterator loads at most 27 deduplicated
neighbor-cell heads. Each head is an atom-plus-one pointer. The 27 pointers occupy
four packed storage words. Each step finds the minimum nonzero head, advances only
that list through the index's authenticated `nextAtom`, and returns the partner
only when `j > i`. Setup, skipped members and exhausted-row transitions each count
as work. One `advance` performs at most 32 such units and returns at most one pair.
Every nonterminal call consumes work, including one that returns no useful pair.

The index builds every cell list in ascending atom order and assigns every atom
to exactly one cell. Neighbor cells are deduplicated, so their lists are disjoint.
Minimum-head merging therefore emits the remaining members in ascending global
order. Discarding `j <= i` and increasing `i` produces each candidate unordered pair
once in the original lexicographic `i,j` order. This preserves the ordering needed
for the later force/energy accumulation; it does not authorize changing its
arithmetic. The existing exact pair displacement/norm/cutoff test must still run.
Uncut exceptions must remain on their separate path.

Pair advancement and the owner's force update must be in the **same transaction**.
A failed force step then rolls back both the iterator and force writes. An EOA
cannot consume a pair independently and strand the Hamiltonian. Completed calls
are idempotent and retain owner, index-runtime, snapshot and protocol checks.
The consumer must propagate a failed force call rather than catch it and keep
the advanced cursor. Geometric completeness alone also does not prove legacy
failure parity: the current all-pairs Hamiltonian mixes parameters before its
cutoff, so even a distant pair with overflowing finite parameters can revert.
Integration must retain a source-bound parameter-domain guard/fallback or declare
and validate a changed failure policy before omitting those computations.

`test/ordered-neighbor-pairs.test.mjs` compiles the new dependency graph in memory
and writes `reports/ordered_neighbor_pairs_validation.json`. It exercises exact
candidate order against independently collected cell membership, inclusion of
all brute-force EVM cutoff pairs, alternate work partitions, unauthorized pulls,
consumer rollback and terminal identity checks. The synthetic consumer does not
evaluate a full Hamiltonian; that integration and independent complete force,
trajectory and sample equivalence remain separate requirements. Receipt gas in
the report is local Shanghai fixture evidence, not target-chain gas, a complete
workload quote or a demonstrated production improvement.
