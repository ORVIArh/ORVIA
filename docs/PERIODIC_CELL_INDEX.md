# Periodic cell candidate index

`PeriodicCellIndex` builds cell membership on chain from a registered immutable
position snapshot. It is a candidate component, **not connected to the Hamiltonian
pair traversal**. It does not calculate forces or accept supplied cell assignments.
No production speedup or accepted molecular simulation is established here.

The owner registers a source page, frozen snapshot, atom count, position offset and
stride, orthorhombic box and cutoff. Registry/module code hashes, source writer,
snapshot commitment and geometry/numerical policy enter the index commitment.
The constructor admits the exact compiled `FloatMath` runtime; geometry must use
that math dependency and its captured runtime remains pinned. The registered
protocol must identify the reviewed geometry implementation. A matching getter
alone is not scientific source verification.

Permissionless `advanceBuild(id, work)` processes at most 32 atoms. Every position
word is read from the snapshot on chain. Atoms are processed in ascending global
order and appended to cell-linked lists, so each list is naturally sorted. A failed
transaction rolls back its membership writes and build cursor. Completed advances
are idempotent while still checking dependencies. Queries reject partial indices.

The index has at most 64 cells per axis and 262,144 logical cells. It creates no
child contracts. `neighboringCells(id, atom)` derives and deduplicates at most 27
periodic neighbors; grids with one or two cells per axis do not repeat cells.
`cellAtoms(id, cell, cursor, count)` follows at most 128 links. Nonzero cursors are
atom-plus-one pointers and must identify real members of this exact cell/index.
Zero starts at the head; a returned zero cursor with `complete=true` ends the list.
The lists include coincident particles and the querying particle. They do not
silently drop singular interactions, exclusions or direct exceptions.

Future force integration must merge the neighboring sorted lists into ascending
global partner order, skip self/previous unordered pairs explicitly, and apply the
original ordered EVM displacement, squared-distance and square-root cutoff test.
Direct uncut exceptions must remain outside this candidate path. Pagination is a
read interface, not permission for an external caller to choose which scientific
pairs a production evaluator processes.

## Restricted numerical domain

The candidate fails closed outside these registered/build-time limits:

- Each box length `L` lies in `[2^-32, 2^32]` and uses the existing positive,
  finite orthorhombic geometry convention.
- `2^-64 <= cutoff < L/2` on every axis.
- Each position satisfies `abs(fl(position/L)) <= 2^30`. This also bounds a pair
  difference to approximately `2^31` boxes, within geometry's `2^32` image guard.
- Input words use canonical low-128-bit finite binary128 encodings.

The cell width uses a deliberate conservative margin:

```text
g = 1 + 2^-32
n = min(64, trunc_to_uint(fl(L / fl(cutoff*g))))
width = L/n                                      # exact-real width for the proof
```

Position assignment calls the existing geometry's displacement from the origin,
adds `L/2`, maps the periodic upper boundary to zero, and truncates the represented
`fl(fl(wrapped*n)/L)` to an integer. Adding half a box chooses a grid origin; it
does not alter the molecular coordinates or force calculation.

The supported domain is intentionally narrower than all finite binary128 values.
An unsupported position or unresolved image is an explicit failed build. A future
fallback must be declared and tested; this component never silently substitutes
an approximate distance or changes a potential.

## Conservative error argument

This argument concerns the **pinned ABDK implementation**, not a claim of universal
correct rounding or round-to-nearest IEEE arithmetic. In the source:

- `add` aligns same-sign significands by right shifts; its opposite-sign path uses
  a directed sticky adjustment before subtraction and normalization. `sub` calls
  that path with the opposite sign. Cancellation therefore needs an absolute
  operand-scale bound, not a relative bound on the small result.
- `mul` forms the full at-most-226-bit significand product and normalizes by right
  shift. `div` performs integer division with guard bits and then right-shifts the
  quotient to the retained significand. These operations truncate.
- `toInt`/`toUInt` truncate the represented value toward zero exactly. Small integer
  image counts and cell counts convert back exactly.

Use the conservative envelope `epsilon=2^-110` times the maximum operand scale for
addition/subtraction, and times the exact result scale for normal multiplication
and division. This allows four full significand ulps, rather than the unsupported
nearest-rounding assumption `u=2^-113`. Include one minimum-subnormal quantum
`eta=2^-16494` for a possible subnormal result. The normal multiply/divide shifts
lose less than a full retained ulp each; division's earlier integer quotient loss
is also covered. Alignment/sticky losses and final normalization in add/sub are
covered on the larger operand's scale, even under cancellation.

For each axis let `M=2^30`. The admitted represented quotient bounds the exact
position magnitude by `(M+eta)/(1-epsilon)*L`. The geometry's integer image is at
most `M`; if truncating a quotient changes the chosen lattice integer near a
boundary, that is a whole periodic shift and is compared on the periodic torus.
The multiply-by-image and subsequent subtract contribute at most

```text
epsilon*M*L + epsilon*max((M+eta)/(1-epsilon), M*(1+epsilon))*L
```

Additional half-box correction, shift and scaling into a cell contribute a small
multiple of `epsilon*L`, plus subnormal quanta. Allowing eight such epsilons and
sixteen scaled quanta gives **point wrapping plus binning error `< 2^-72*L`**.
Taking `eta/L <= 2^-16462` covers the smallest supported box. A bin boundary can
move, so the argument treats a computed bin as the exact bin of a nearby point;
it does not assume boundary classification is exact.

For a pair, first subtract the two positions. Bound that subtraction on their
maximum input scale, use an image bound `2*M+2`, then bound the image product,
remainder subtraction and correction the same way. Padding those terms gives
**pair minimum-image error `< 2^-71*L`**. Two binned points and that pair displacement
therefore differ by at most **`2^-70*L`** on the periodic axis.

For grid selection the normal product/division envelope gives

```text
width/cutoff >= (1+2^-32)*(1-epsilon)/(1+epsilon) > 1+2^-33
width-cutoff > 2^-40*L                            # n <= 64
```

The explicit cap can only enlarge the width. If two cells are not periodic
neighbors, their exact binned points differ by at least one width on some axis.
After the combined error, the EVM displacement on that axis still exceeds
`cutoff*(1+2^-34)`. The width margin is thus over a billion times larger than the
combined wrapping/binning envelope; the margin is justified by these bounds,
not by its numeric size alone.

The retained exact EVM cutoff test squares components, sums nonnegative terms in
order and takes ABDK's square root. An omitted pair would have a component larger
than the cutoff, so its relevant squared component is normal (`cutoff >= 2^-64`),
and the positive sums cannot fall below the largest represented squared term.
The square-root implementation normalizes its integer radicand into
`[2^224,2^226)`, starts at `2^112`, performs seven integer Newton steps and selects
the smaller final reciprocal estimate. A first-step relative error at most
`1/4+epsilon`, six further conservative recurrences
`e <- e^2/[2*(1-e)] + epsilon`, and the final reciprocal/shift loss bound its error
by `2^-100` in this normal regime. Consequently

```text
(1+2^-34)^2 * (1-epsilon) * (1-2^-100)^2 > 1
```

so such an omitted pair cannot pass the original EVM square-root cutoff test.
This does not require treating that square root as correctly rounded.

`reference/periodic_cell_bounds.py` checks the padded error inequalities and Newton
recurrence using exact rational arithmetic. It checks the algebra after the
source-audited operation envelopes, not every Solidity/EVM branch mechanically.
The argument is restricted to the declared domain and the actual registered,
reviewed geometry/math runtimes. It is not a universal numerical proof for other
modules, extreme finite values or a complete molecular trajectory.

## Verification and limits

`node --test test/periodic-cell-index.test.mjs` compiles its dependency graph in
memory and writes `reports/periodic_cell_index_validation.json`. Tests compare
candidate membership with a separate test-only brute-force consumer using the
same exact EVM geometry and ordered norm operations. They also exercise negative
and long-unwrapped coordinates, periodic ties, adjacent binary128 values at a
cell face, coincident atoms, small-axis deduplication, grid limits, frozen source
identity, rollback, pagination and transaction partitioning. The large-index
fixture processes every one of 1,500 atoms at source-word offsets above one
million; it is not a full molecular force pass.

This component has no force-evaluator integration or measured full-pair traversal
speedup. Its fixed cell index does not remove storage, retained checkpoints,
reciprocal electrostatics, constraints, alchemical sampling or scientific input
acceptance requirements.
