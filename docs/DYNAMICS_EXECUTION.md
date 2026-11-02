# Resumable finite-system dynamics

`DynamicsCoordinator` executes velocity Verlet across bounded transactions. It reads frozen paged coordinates, velocities, masses and interaction records, calculates all five supported force terms in the EVM, and stores current and staged positions, velocities, forces and potential energy in an isolated working-page namespace.

This is a finite-system dynamics component. Its supported terms are harmonic bonds, harmonic angles, periodic torsions and explicitly listed unswitched Lennard–Jones plus direct Coulomb pairs. It does not implement periodic boundaries, neighbor-list construction, constraints, thermostat/barostat, PME, solvent preparation, alchemical sampling or a binding-free-energy estimate.

## Configuration and registration

The constructor is `DynamicsCoordinator(owner, modules)`, where `modules` is this tuple in order:

```text
(registry, dataset, math, integrator, bond, angle, torsion, lj, coulomb, elementary)
```

Every module must have deployed code. The coordinator checks each kernel's immutable arithmetic dependency and both angular kernels' elementary-math dependency. It pins all ten module code hashes. The supplied modules have no upgrade path; hash checks alone would not freeze arbitrary storage-backed proxy behavior.

Deploy `WorkingStatePage(coordinator)` afterward, then call `bindWorkingPage(page)` as owner. Binding is irreversible, requires the coordinator as the page's immutable writer, and pins the page code hash. The registered protocol must include all listed modules except the registry itself, plus the coordinator and its working page. The registry is separately pinned in the core configuration.

`registerExperiment(protocolId, datasetId, dt, steps)` is owner-only. It binds the frozen `DynamicsDataset`, validates finite positive `dt`, and accepts 1–4,096 timesteps and 2–1,024 atoms. The initial-input catalog supplies at least one bond. The development cap is not a specification for a fully solvated myosin system.

Numerical validation of the dataset is staged rather than performed in one potentially unbounded registration transaction. The coordinator validates every mass, coordinate, velocity and interaction record before initial force evaluation. Singular geometry and exceptional arithmetic are checked by the kernels during evaluation and can still stop a run.

## Exact state machine

Anyone may call `advanceExperiment(id, workLimit)`, where `workLimit` is 1–8. A work unit processes one atom or one interaction record. A listed pair evaluates both Lennard–Jones and Coulomb contributions as one record. The coordinator selects the next record; callers cannot select or skip interactions, change inputs, or submit numerical results.

| Value | Stage | One work unit |
|---:|---|---|
| 0 | Missing | Invalid run |
| 1 | Loading | Validate one positive mass and finite initial position/velocity; load buffer 0 |
| 2 | ValidatingBonds | Validate one bond's indices and parameters |
| 3 | ValidatingAngles | Validate one angle's indices and parameters |
| 4 | ValidatingTorsions | Validate one torsion's indices, periodicity and parameters |
| 5 | ValidatingPairs | Validate one listed pair's indices and parameters |
| 6 | InitialBonds | Accumulate one initial bond force/energy |
| 7 | InitialAngles | Accumulate one initial angle force/energy |
| 8 | InitialTorsions | Accumulate one initial torsion force/energy |
| 9 | InitialPairs | Accumulate one initial LJ+Coulomb pair force/energy |
| 10 | Drift | Apply first half-kick and drift for one atom into the inactive buffer |
| 11 | NextBonds | Accumulate one new-state bond force/energy |
| 12 | NextAngles | Accumulate one new-state angle force/energy |
| 13 | NextTorsions | Accumulate one new-state torsion force/energy |
| 14 | NextPairs | Accumulate one new-state LJ+Coulomb pair force/energy |
| 15 | Kick | Apply final half-kick for one staged atom |
| 16 | Completed | No further writes or advancement |

Each nonempty stage consumes all its records in input order. Empty optional angle/torsion/pair stages are skipped deterministically without artificial work units. A transaction may cross stage boundaries while its budget remains.

After the last initial force record, the next stage is Drift. Drift uses the complete current force vector. After every next position and half-step velocity is present, the coordinator performs the complete next-force pass. Only then may final Kick begin. At the last atom of Kick, the coordinator atomically flips the active buffer and increments `completedSteps`. If more steps remain, it returns to Drift with cursor zero; otherwise it seals the entire namespace and enters Completed. The final cursor is the atom count.

The initial Loading/Initial force stages are explicitly incomplete initialization states. After initialization, current coordinates and velocities are never overwritten during calculation of their successor. Consumers must inspect the run status and completed-step counter rather than interpreting raw staged words as a committed state.

## Velocity Verlet and accumulation order

For each atom, the integration module calculates:

```text
v_half = v_current + (dt / (2 mass)) * F_current
x_next = x_current + dt * v_half
v_next = v_half + (dt / (2 mass)) * F_next
```

The masses are read from the frozen particle stream on-chain. New forces are computed only after the drift stage is complete. There is no random draw or temperature control in this integrator.

Each force pass uses fixed bond → angle → torsion → listed-pair order. A pair combines its LJ and Coulomb energies and force components before adding them to the total. No implicit atom-pair enumeration, mixing rule, exclusion list or cutoff is added. The dataset must explicitly state the intended pair list and pair parameters.

Changing transaction partition, sender or wall-clock delay leaves the arithmetic order unchanged. A reverted transaction rolls back every coordinator and working-page write, including any earlier work or step commit within that transaction. Earlier successful transactions remain committed. A failed geometry therefore cannot silently advance or complete the run.

## Working-page layout

There are two buffers. With `N = atomCount`, buffer `b` and atom `i`, its nine-word record begins at `9*N*b + 9*i`:

| Offset within atom record | Data |
|---:|---|
| 0–2 | x, y, z |
| 3–5 | vx, vy, vz |
| 6–8 | Fx, Fy, Fz |

Potential energy for buffer `b` is at `18*N + b`. Total namespace capacity is `18*N + 2` words. Every numeric word uses the low 128 bits for its binary128 bit pattern; the high half must be zero.

The first Drift atom resets the inactive buffer's potential energy. Each Drift record writes its next position and half-step velocity and clears its three inactive force words. The next-force stages cannot begin before every atom has completed Drift. This prevents stale force/energy accumulation when buffers are reused on later steps.

## Read APIs and commitments

`runInfo(id)` returns:

```text
(protocolId, datasetId, commitment, stateNamespace, cursor,
 completedSteps, targetSteps, atomCount, activeBuffer, status, potentialEnergy)
```

`stateAt(id, atom)` returns the active buffer's `(position, velocity, force)` arrays. `experimentParameters(id)` returns `(dt, bondCount, angleCount, torsionCount, pairCount, datasetCommitment)`. Initial loading/force stages can expose partial initialization; later staged data remain visible only through direct raw page inspection until their buffer is committed.

The core configuration hash is `keccak256(abi.encode(modulesTuple, bytes32[10](moduleCodeHashes)))`, using the constructor tuple order. The one-time configuration is `keccak256(abi.encode(coreConfigurationHash, workingPageAddress, workingPageCodeHash))`.

The namespace and run commitment use Solidity `abi.encode`:

```text
namespace = keccak256(abi.encode(
    bytes32("ORVIA-DYNAMICS-STATE-v1"), uint256(chainId),
    address(coordinator), uint256(runId)
))
commitment = keccak256(abi.encode(
    bytes32("ORVIA-DYNAMICS-RUN-v1"), uint256(chainId), address(coordinator),
    uint256(runId), bytes32(protocolManifest), bytes32(datasetId),
    bytes32(datasetCommitment), bytes32(configurationHash), bytes16(dt),
    uint32(targetSteps), bytes32(namespace)
))
```

The dataset identity, timestep and trajectory length cannot be edited for an existing experiment. An implementation change requires a newly deployed and registered protocol. Completed outputs are immutable.

## Evidence boundary

The source compiles with Solidity 0.8.26, optimizer 200, Shanghai EVM and no viaIR. Integrated test logs and the trajectory comparison report establish which numerical and interruption checks actually passed. A successful tiny finite-system trajectory does not validate a full myosin force field, realistic ensemble sampling, binding affinity or clinical effect.
