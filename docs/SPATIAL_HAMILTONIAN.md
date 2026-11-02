# Ordered spatial Hamiltonian integration

The optional spatial path builds its cell membership on chain from the same authenticated frozen position namespace used by `AlchemicalHamiltonianEvaluator`. It does not accept caller-supplied cells or pairs. `PeriodicCellIndex` and `OrderedNeighborPairs` add two actual contracts; they create no children. The integration preserves the existing binary128 pair kernels, force accumulation order, finite Ewald modes, bonded terms and direct exception processing.

## Binding and identity

Deploy the Hamiltonian first, then `PeriodicCellIndex(H, registry, math, geometry)` and `OrderedNeighborPairs(H, cellIndex)`. The Hamiltonian owner calls `bindSpatial(cellIndex, orderedPairs)` once before the first evaluation. The Hamiltonian verifies the shared registry/math/geometry and both owner relationships, captures both runtime hashes, and requires both modules in the evaluation's immutable protocol registry. Its evaluation commitment binds `SPATIAL_POLICY_ID`, both module addresses and captured runtime hashes. Deployment admission must register the reviewed concrete module runtimes; matching getters alone do not establish their behavior.

The pipeline owner forwarder must freeze this configuration before its first campaign is created, rather than only before its first run. The existing public getters expose `SPATIAL_POLICY_ID`, `spatialIndex`, `spatialPairs`, `spatialIndexCodeHash` and `spatialPairsCodeHash` for the pipeline campaign commitment. Pipeline integration is separately tested; this fixture exercises the Hamiltonian through a test owner contract.

## Bounded execution and fallback

The existing Atoms stage performs the same finite-parameter eligibility checks used by the guarded cutoff path. The spatial path additionally requires box lengths in `[2^-32, 2^32]`, cutoff at least `2^-64`, at least two atoms, and every position component within `2^30` corresponding box lengths. Screening uses safe exact power-of-two multiplication, avoiding a new potentially overflowing division on an unsupported input. Such inputs continue through the original all-pairs path.

Eligible evaluations enter the appended `CellBuild` stage, numeric value 12; the historical `Complete` value remains 11. Index construction consumes the supplied bounded work. A completed authenticated index starts an owner-only ordered traversal. Traversal setup, list skips and row transitions consume work, while each returned candidate consumes the original `_normalPair` operation unless the unchanged exception map excludes it. Each call returns at most one candidate from the iterator, and every nonterminal iterator response must consume positive work. An unexpected no-progress response reverts.

Candidate pairs retain increasing `(i,j)` order. During spatial Pairs, `runInfo.cursor` is one plus the last returned pair's canonical all-pairs ordinal; it can jump across omitted pairs. `spatialInfo.candidateVisits` counts only returned candidate pairs, including candidates screened by the exception map. `legacyVisits` counts visited all-pairs slots when fallback is selected. Neither counter counts setup/skips as evaluated pairs. Both paths reset the ordinary cursor when advancing to reciprocal work or Background.

Only the cell index's `UnsupportedDomain` and the reviewed geometry's `ImageRangeExceeded` / `UnresolvedImage` errors select fallback, before bonded or pair forces start. Dependency, source, registry, storage and arbitrary execution failures propagate. Iterator consumption and the corresponding original force operation share the same transaction and uncaught revert, so a failed force does not lose its pair. Runtime and frozen-snapshot authentication still runs before every advance, including completed idempotent calls.

The conservative numerical-domain argument and its limits are in [PERIODIC_CELL_INDEX.md](PERIODIC_CELL_INDEX.md). Omitted pairs are outside the original cutoff under that argument. Returned candidates still use the original ordered squared distance, `FloatMath.sqrt` and cutoff comparison. Direct exceptions remain uncut and outside the cell path. The parameter guard also preserves the original pre-cutoff overflow failure for unsupported finite mixing parameters.

## Recorded verification

[spatial_hamiltonian_isolated_validation.json](../reports/spatial_hamiltonian_isolated_validation.json) records the original complete local EVM run: five substantive checks passed, with no skips. The archived runner and exact compiler input are in `test/fixtures/spatial-hamiltonian/`. [spatial_hamiltonian_packaging.json](../reports/spatial_hamiltonian_packaging.json) verifies the canonical promoted source, all original dependency hashes, the preserved runner/report, the portable runner's four path-only replacements, and a fresh compile. Packaging did not rerun the full EVM fixture. To run the portable fixture:

```sh
node --test test/spatial-hamiltonian-integration.test.mjs
```

The fixture compares all ten energy component words, all atom-force words and the total energy word against the frozen guarded-cutoff baseline. It covers a charged interior-lambda model with bonds, angles, periodic torsions, exceptions and all 13 finite Ewald modes; cutoff values immediately below/at/above one binary128 value; successful unsupported-domain fallback; the original nonfinite mixing failure; and a sparse system with a nonzero uncut exception at a distance of 60 nm. The charged case uses different advance partitions to check bounded continuation parity. Independent cell and iterator fixtures cover immutable source authentication, runtime changes, rollback, list partitioning, periodic boundaries and large global source indices.

Actual local advancement receipt totals include cell construction and traversal, but exclude deployment, input upload, topology validation and evaluation registration:

| Fixture | Baseline advancement gas | Spatial advancement gas | Interpretation |
| --- | ---: | ---: | --- |
| 16 sparse LJ atoms, one distant uncut exception; work 8 on both paths | 33,656,405 | 20,818,524 | 120 all-pairs visits become zero cell candidates; 12,837,881 gas saved (38.14%) |
| 4 atoms adjacent to cutoff; work 8 on both paths | 4,703,971 | 11,538,380 | Small dense case costs more after index/traversal setup |
| 4 charged mixed atoms with complete finite Ewald | 111,148,139 | 130,415,491 | Different work partitions (8 versus 1/8/3); exact result parity, not a matched gas comparison |

These are small local fixtures on a Shanghai Ganache chain with the contract-size limit explicitly relaxed. The promoted Hamiltonian runtime template is 34,449 bytes. This is not target-chain full-Hamiltonian deployment acceptance, a full prepared myosin benchmark, a whole-campaign fee quote, a universal floating-point proof, an accepted physical ensemble or an alchemical C4 integration. Prepared-model, force-field, initial constraint-manifold, electrostatic convergence and scientific sampling gates remain separate.
