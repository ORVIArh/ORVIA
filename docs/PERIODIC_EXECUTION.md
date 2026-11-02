# Resumable periodic dynamics

`PeriodicDynamicsCoordinator` is the v0.4 alternative to the finite-system `DynamicsCoordinator`. It computes a declared orthorhombic, constant-volume molecular Hamiltonian and velocity-Verlet trajectory entirely in contracts. The caller supplies only an experiment ID and bounded work allowance. Scientific results are not submitted by the caller.

This increment implements an exact all-pairs scan for the declared cutoff model. It has no cached neighbor list, PME/Ewald sum, long-range dispersion correction, constraint solver, thermostat, barostat, alchemical estimator or prepared myosin parameter set. The conducting-limit reaction-field model is an explicit engineering model, not a claim of sufficient electrostatics for the intended binding calculation.

## Modules and registration

The constructor is `PeriodicDynamicsCoordinator(owner, modules)` with this ordered tuple:

```text
(registry, dataset, math, integrator, bond, angle, torsion, lj, coulomb,
 elementary, geometry, nonbonded)
```

`dataset` is a `PeriodicDataset`; `geometry` is `OrthorhombicGeometry`; `nonbonded` is `SwitchedNonbondedKernel`. Every module must have code. All twelve code hashes are pinned. The constructor checks every arithmetic dependency against `math`, both angular kernels against `elementary`, and the nonbonded kernel's direct LJ and Coulomb dependencies against the supplied modules. Arbitrary proxy storage is not frozen by a code hash; the provided components do not expose upgrades.

Deploy `WorkingStatePage(coordinator)` and bind it once as owner. A registered protocol must include every module except the separately pinned registry, plus the coordinator and its working page. `registerExperiment(protocolId, datasetId, dt, steps)` is owner-only and binds the frozen dataset commitment, finite positive timestep, and 1–4,096 steps. The development cap is 2–1,024 atoms; the underlying input schema still requires at least one bond. These caps are not a supported size specification for solvated cardiac myosin.

The periodic configuration is immutable for each dataset/run: positive box lengths, `0 < switchDistance < cutoff < min(box)/2`, and a finite nonnegative Coulomb prefactor. The periodic dataset supplies exactly `N*(N-1)/2` candidate pairs, calculated from the particle count rather than uploaded as a chosen normal-pair list.

## Numerical initialization and exceptions

Loading validates mass, initial position/velocity and per-particle nonbonded parameters. Every sigma must be positive, epsilon nonnegative and charge finite. Subsequent stages validate all bonds, angles, torsions and exception records before any initial force pass.

Exception records are `(a, b, kind, sigma, epsilon, chargeProduct)`. They must satisfy `a < b < N` and be strictly sorted by `a*N+b`. Duplicate, reversed or out-of-order records therefore fail closed. Kind 1 excludes the pair and requires each of the three numeric parameter words to be exactly canonical positive zero. Kind 2 supplies explicit sigma, epsilon and signed charge product; sigma must be positive and epsilon nonnegative. The coordinator builds a run-local lookup only as each record passes validation. A reverted transaction rolls back the lookup and all other writes in that transaction.

The protocol accepts a declared exception table; it does not derive bond-graph exclusions or audit the table against a prepared molecular topology. Correct force-field exceptions remain part of scientific input preparation. A regular pair cannot disappear through an omitted pair record: all unordered pairs are enumerated, and absence from the exception table means a regular interaction.

## Geometry and force order

Positions and velocities are stored unwrapped. Each displacement is computed in the nearest orthorhombic image from the current buffer. Bonded kernels receive reconstructed local coordinates:

- Bond: origin and the minimum-image bond displacement.
- Angle: vertex at the origin and the two minimum-image arms.
- Torsion: a chain reconstructed from its three consecutive minimum-image bond displacements.

Bonded displacements and uncut direct exceptions reject any component exactly at half a box length. The nearest image is nonunique there and a differentiable force is not defined. Ordinary cutoff interactions are already zero at such a separation because the cutoff is strictly smaller than every half-box length. `OrthorhombicGeometry` also enforces its finite, bounded image-reduction domain; exceptionally large unwrapped separations fail instead of invoking an unbounded loop.

Each force pass runs bonds, angles, torsions, then all unordered pairs in lexicographic order: `(0,1), (0,2), ... (N-2,N-1)`. A bounded integer binary search maps the pair cursor to the indices in at most ten iterations for the 1,024-atom cap. Transaction partition and sender do not change that order.

Regular pair parameters are computed on-chain by Lorentz–Berthelot mixing: arithmetic mean sigma, geometric mean epsilon, and the product of charges. The nonbonded kernel combines switched Lennard–Jones energy and conducting-limit reaction-field electrostatics. A regular pair at or beyond cutoff returns zero. Kind-1 exclusions skip geometric evaluation and contribute zero. Kind-2 exceptions use their explicit parameters with the nearest image and direct, uncut, unswitched LJ plus Coulomb energy. Their contributions remain active beyond the normal cutoff. See `SWITCHED_NONBONDED.md` for the equations and limits.

This model has one constant orthorhombic box and a specified nearest-image bonded convention. It does not support arbitrary triclinic cells, independently periodic topology images or large-molecule bonded-image reconstruction beyond that convention.

## Bounded state machine and commit barrier

Anyone may call `advanceExperiment(id, workLimit)` with `workLimit` 1–8. One work unit processes one atom, bonded interaction, exception validation record or enumerated unordered pair. Excluded and outside-cutoff pairs still consume one pair work unit. Normal-pair enumeration is O(N²) over the entire force pass; it is distributed over transactions, not hidden in an unbounded call. There is no claim of neighbor-list acceleration.

| Value | Stage | Work unit |
|---:|---|---|
| 0 | Missing | Invalid run |
| 1 | Loading | One atom and its nonbonded parameters |
| 2 | ValidatingBonds | One bond |
| 3 | ValidatingAngles | One angle |
| 4 | ValidatingTorsions | One torsion |
| 5 | ValidatingExceptions | One canonical sorted exception |
| 6–9 | InitialBonds, InitialAngles, InitialTorsions, InitialPairs | One interaction or unordered pair |
| 10 | Drift | One first half-kick and drift into the inactive buffer |
| 11–14 | NextBonds, NextAngles, NextTorsions, NextPairs | One next-state interaction or unordered pair |
| 15 | Kick | One final half-kick |
| 16 | Completed | Sealed, no further writes |

Empty optional validation/force stages are skipped without artificial work. No force pass begins before its positions and input validation are complete. Only the last final kick flips the active buffer and increments the completed step count. A transaction can cross this boundary if it has remaining work; a later failure in that same transaction rolls back that commit as well as all other writes from the transaction. Successful earlier transactions remain unchanged.

The first drift atom clears the inactive potential energy; each drift atom clears its inactive forces. Completed runs seal their namespace. Initial loading and initial force accumulation are explicitly incomplete initialization states; read the status before interpreting active data as an initialized checkpoint.

## Storage, APIs and identity

The working page layout remains `18*N+2` words: two buffers of nine words per atom (position, velocity, force), followed by two potential-energy words. Values use the low 128 bits of each word. At most the current and previous/trial states are retained; a complete history of all trajectory samples is not retained on-chain.

`runInfo`, `stateAt` and `experimentParameters` retain the finite engine's field ordering. `experimentParameters` reports the full unordered-pair count. `periodicParameters(id)` returns `(box, switchDistance, cutoff, prefactor, exceptionCount)`.

All commitments use Solidity `abi.encode` and Keccak-256:

```text
coreConfigurationHash = keccak256(abi.encode(modulesTuple, bytes32[12](codeHashes)))
configurationHash = keccak256(abi.encode(coreConfigurationHash, workingPage, workingPageCodeHash))
namespace = keccak256(abi.encode(bytes32("ORVIA-PERIODIC-STATE-v1"),
    uint256(chainId), address(coordinator), uint256(runId)))
commitment = keccak256(abi.encode(bytes32("ORVIA-PERIODIC-RUN-v1"),
    uint256(chainId), address(coordinator), uint256(runId), bytes32(protocolManifest),
    bytes32(datasetId), bytes32(datasetCommitment), bytes32(configurationHash),
    bytes16(dt), uint32(targetSteps), bytes32(namespace)))
```

The periodic dataset commitment transitively binds the box, cutoff, switch distance, prefactor, per-atom parameters, exception table and all original dynamics streams. A completed run cannot be reconfigured or resumed. A protocol implementation change requires new deployment and registration.

## Validation boundary

`test/periodic-dynamics.test.mjs` compares the contract's entire three-step, four-atom periodic trajectory with an independent 90-digit scalar-energy differentiation oracle. The fixture crosses a box face while its stored coordinates remain unwrapped. It exercises bonded images, regular interactions inside the switch region and outside cutoff, an exclusion and a direct exception. Other checks cover batch partition identity, independently reconstructed commitments, staged-state visibility, singular and half-box rollback, malformed parameters/exceptions, authority and terminal sealing.

Gas reports cover actual successful local-EVM advancement transactions. They exclude deployment and input uploads and do not estimate Robinhood fees, solvated-protein runtime or binding-free-energy cost. Passing these engineering fixtures does not validate prepared chemistry or a clinically meaningful drug result.
