# Resumable Verlet candidate lists

`NeighborList` builds and checks an on-chain list of pairs for the existing fixed-box cutoff Hamiltonian. `NeighborDynamicsCoordinator` is an alternative to the exhaustive `PeriodicDynamicsCoordinator`; it retains the same bonded forces, switched LJ, conducting reaction field, direct exception semantics and velocity-Verlet integration. It changes pair selection work, not the declared potential.

This remains a bounded development implementation. Building a list scans all unordered pairs in O(N²); there is no spatial cell decomposition. Reuse avoids repeating ordinary force-kernel and input-parameter work for distant pairs. It does not make full-protein preparation or Ewald/PME complete.

## Candidate coverage and reuse

The configured list radius is `r_list = cutoff + skin`, strictly less than every half-box length. Ordinary pairs at or within this radius are candidates. Exclusions are omitted. Direct uncut exceptions are included regardless of distance. All retained candidates keep their global lexicographic unordered-pair indices, so ordinary and exception forces are accumulated in precisely the exhaustive engine's order.

A direct exception does not rely on cutoff coverage or motion bounds. Its force is still computed by the direct, uncut kernel on every force pass. Keeping it in the same ordered union avoids changing summation order by moving exceptions into a later force pass.

Before reuse, the list checks every atom against its last build position. Stored coordinates are unwrapped; displacement checking uses the unwrapped difference, making a large cell crossing trigger a conservative rebuild rather than appear stationary after wrapping. All atoms must have displacement strictly below `127/256` of the effective skin, a margin below half-skin. Equality triggers rebuilding. The effective skin is the smaller of the requested skin and the representable `r_list - cutoff`.

The standard coverage argument is the triangle inequality: if each particle moved less than half the buffer, an omitted pair cannot enter the interaction cutoff. The numerical implementation reserves additional margin, includes list-radius equality and rejects effective skins smaller than any box-axis length divided by `2^32`. Bounding the margin against the box, rather than only the list radius, conservatively excludes tiny skins and extreme box/list-radius ratios where image-reduction rounding could dominate the margin. It also rejects a skin that rounds away when added to the cutoff, squared-radius/threshold underflow, nonfinite arithmetic and geometry outside the bounded-image domain. These are declared numerical domains; they are not a proof of arbitrary-input binary128 rounding correctness.

## Immutable writer and frozen snapshots

Deploy the coordinator first, then `WorkingStatePage(coordinator)`, then:

```text
NeighborList(writer=coordinator, math, geometry, workingPage)
NeighborDynamicsCoordinator.bindWorkingPage(workingPage, neighborList)
```

Binding is owner-only and irreversible. The list verifies its page's immutable writer and the geometry's arithmetic dependency. It pins arithmetic, geometry and page code hashes. The coordinator additionally pins the list runtime code hash and requires it in the registered protocol. The resulting configuration commitment binds both workspace addresses and hashes.

Only the coordinator may register, prepare or mutate a list. The list reads numerical coordinates directly from its bound working page; callers never submit a candidate set, computed displacement or force. Each list is keyed by the coordinator's unique state namespace, and its configuration and exception table freeze before the first build.

The coordinator keeps the selected position buffer unchanged throughout list preparation and force evaluation. This is an enforced coordinator-stage invariant. `NeighborList` is not safe to pair with an arbitrary writer that edits the source position buffer during checking/copying; its immutable writer is part of the trusted executable protocol.

## List state machine

| Value | State | Work unit |
|---:|---|---|
| 0 | Missing | Invalid list |
| 1 | Registered | Configuration/exception table may be completed by writer |
| 2 | Checking | Check one atom's displacement from the build reference |
| 3 | Copying | Copy one atom's frozen position into reference storage |
| 4 | Building | Screen one lexicographic unordered pair |
| 5 | Ready | Candidate list may be consumed |

`advance(namespace, work)` accepts 1–8 units and is writer-only. First preparation copies a complete coordinate snapshot, then builds from that reference. Later preparation checks all atoms. If any requires rebuilding, it copies a new complete reference and rescans all pairs; otherwise it returns to Ready and increments the reuse count.

Partial lists cannot be read through `pairIndexAt` or `referenceAt`. Rebuild resets the visible candidate count and overwrites reusable mapping entries; old tail entries remain inaccessible. No unbounded array deletion is required. A failed transaction rolls back all list, coordinator and page writes performed in that transaction. Earlier successful partial work remains staged and cannot be interpreted as a complete list.

The atom cap is 1,024. Each pair index is inverted by bounded integer binary search. The list's candidate count, generation, reuse count, selected buffer, stage and cursor are public through `listInfo`.

## Coordinator integration

The constructor retains the periodic engine's twelve-module tuple. `registerExperiment(protocolId, datasetId, dt, steps, skin)` adds a finite positive skin to the immutable run configuration. The dataset remains `PeriodicDataset`; its uploaded explicit pair stream must be empty, and its explicit exception stream supplies exclusions or parameter overrides.

The nonbonded module has two explicit constructor admission policies. The original switched kernel retains its external math/LJ/Coulomb identity checks. Alternatively, the exact compiled `InlineNonbondedKernel` runtime is admitted together with the exact compatible pinned `FloatMath` runtime; copied implementation identifiers alone are insufficient. `nonbondedPolicy` exposes the selected immutable policy. Both paths use the existing module-code commitments and per-advancement checks. The inline path retains the same Hamiltonian and arithmetic sequence and has no external arithmetic-dependency getters. See [compute cost](COMPUTE_COST.md) for provenance and the full-trajectory comparison.

| Value | Coordinator state |
|---:|---|
| 0 | Missing |
| 1 | Loading |
| 2–5 | ValidatingBonds, ValidatingAngles, ValidatingTorsions, ValidatingExceptions |
| 6 | PreparingInitial |
| 7–10 | InitialBonds, InitialAngles, InitialTorsions, InitialPairs |
| 11 | Drift |
| 12 | PreparingNext |
| 13–16 | NextBonds, NextAngles, NextTorsions, NextPairs |
| 17 | Kick |
| 18 | Completed |

The main `advanceExperiment` budget is shared across list and dynamics work. PreparingInitial freezes buffer 0; PreparingNext begins only after all drifted positions exist in the inactive buffer. Force stages cannot begin until the corresponding list is Ready. The same two-buffer final-kick commit barrier and terminal sealing remain in force. Zero-candidate pair stages skip deterministically.

`runInfo`, `stateAt`, `experimentParameters` and `periodicParameters` preserve their field layouts. `experimentParameters.pairCount` remains the total unordered-pair count, while `neighborList.listInfo(namespace).candidateCount` gives the current retained count. `neighborParameters(id)` returns the registered skin and bound list address.

Commitments use ABI encoding and Keccak-256:

```text
configuration = hash(coreConfigurationHash, workingPage, workingPageCodeHash,
                     neighborList, neighborListCodeHash)
namespace = hash(bytes32("ORVIA-NEIGHBOR-STATE-v1"), chainId, coordinator, runId)
run = hash(bytes32("ORVIA-NEIGHBOR-RUN-v1"), chainId, coordinator, runId,
           protocolManifest, datasetId, datasetCommitment, configuration,
           dt, targetSteps, skin, namespace)
```

## Validation and measurements

`test/neighbor-list.test.mjs` checks staged availability, independently computed candidate coverage, exact-radius inclusion, distant direct exceptions, motion/face crossings, rebuilds for entering pairs, isolated namespaces, partition identity, transaction rollback, code identity and invalid configuration.

`test/neighbor-dynamics.test.mjs` compares complete on-chain trajectories bitwise against the exhaustive periodic coordinator, including periodic bonded geometry, list reuse/rebuilding and alternate transaction schedules. It separately tests skin/configuration commitments, rollback across preparation and force evaluation, and a sparse six-atom system containing a direct exception beyond the ordinary cutoff.

The inline-kernel trajectory is also compared against the original neighbor path at initial force completion and every completed timestep. Its tests cover interrupted drift, alternative transaction schedules, failure rollback, copied identity rejection, incompatible arithmetic rejection and changed module-code rejection. Reported advancement gas compares identical inputs, step counts and transaction schedules on the same local chain.

Gas reports identify their own fixture, advancement schedule and engine. They exclude deployment, data upload and registration. Tiny-system overhead can make a neighbor list more expensive than exhaustive scanning; any claimed saving must use the measured sparse fixture and cannot be extrapolated to a complete protein or Robinhood fee quote. The current Hamiltonian still has conducting reaction-field electrostatics, not Ewald/PME, and no constraints, thermostat, barostat or free-energy estimator.

The general buffered-list reasoning is described in the [GROMACS Verlet buffer documentation](https://manual.gromacs.org/current/reference-manual/algorithms/molecular-dynamics.html). ORVIA uses an explicit displacement-triggered conservative rebuild criterion; it does not implement GROMACS's statistical buffer tuning or tolerance model.
