# Bounded Ewald electrostatics

The Ewald components implement orthorhombic, three-dimensional periodic Coulomb electrostatics under conducting (tin-foil) boundary conditions. They use an explicit reciprocal structure-factor sum. There is no mesh, FFT or PME interpolation. `EwaldForceEvaluator` evaluates the complete declared finite sum from a frozen on-chain coordinate snapshot and a frozen particle/exception dataset, across bounded transactions.

This is a numerical/execution component. Its fixture deliberately uses a small reciprocal extent to test every stage without claiming converged electrostatic accuracy. `EwaldDynamicsCoordinator` also integrates these forces with existing bonded and LJ terms using NVE velocity Verlet. Mainnet scientific readiness still requires a prepared system, jointly justified alpha/cutoff/mode settings, comparison with an established implementation, the required production force-field/ensemble workflow, and measured workload.

## Mathematical convention

The Coulomb prefactor `K` is supplied explicitly and must match the declared units. Let `alpha > 0`, fixed orthorhombic volume `V`, charges `q_i`, and reciprocal wave vector `k = 2*pi*(n_x/L_x,n_y/L_y,n_z/L_z)`.

For an ordinary pair at nearest-image separation `r < cutoff`:

```text
U_real = K*q_i*q_j*erfc(alpha*r)/r
F_i = -K*q_i*q_j * [erfc(alpha*r)/r^3
      + 2*alpha*exp(-(alpha*r)^2)/(sqrt(pi)*r^2)] * (r_j-r_i)_image
```

The real pair is zero at or beyond the cutoff. It is not energy-shifted or force-switched. The omitted value at the boundary must be made acceptably small through the registered truncation criterion. No continuity or global accuracy guarantee follows merely from using Ewald equations.

One canonical half-space mode represents both `+n` and `-n`. Its first nonzero integer component must be positive. Define:

```text
A = 4*pi*K/V * exp(-|k|^2/(4*alpha^2))/|k|^2
C = sum_i q_i*cos(k.r_i)
S = sum_i q_i*sin(k.r_i)
U_mode = A*(C^2+S^2)
F_i_mode = 2*A*k*(C*q_i*sin(k.r_i)-S*q_i*cos(k.r_i))
```

The factor 4*pi includes the two signs. Adding both signs again would double reciprocal energy and force. For extent `M`, every canonical vector with components in `[-M,M]` is visited exactly once; their count is `((2*M+1)^3-1)/2`. The origin is excluded.

The self correction is `-K*alpha/sqrt(pi)*sum_i q_i^2`. For nonzero net charge `Q`, this implementation explicitly includes a uniform neutralizing background, `-K*pi*Q^2/(2*alpha^2*V)`. At fixed volume both corrections have zero coordinate force. There is no vacuum-boundary dipole/surface term, slab correction or returned virial tensor. Background treatment must not silently be mistaken for an explicitly neutralized molecular system.

## Exceptions

The periodic dataset contains explicit exclusions or direct parameter overrides. Reciprocal structure factors always use the original particle charges. The evaluator **omits the exception pair's screened real-space interaction**, then adds once, without cutoff:

```text
U_exception = K*[desiredChargeProduct-originalChargeProduct*erf(alpha*r)]/r
```

An exclusion sets `desiredChargeProduct = 0`. This removes the corresponding intracell Coulomb pair while retaining periodic-image contributions. A direct override replaces that intracell interaction with its supplied charge product. Removing a pair from the real-space list alone is insufficient: reciprocal exclusion correction is essential.

The exception uses a nearest-image displacement and rejects exact half-box component ties. At a coincident excluded pair, the correction has the finite limit `-2*K*originalChargeProduct*alpha/sqrt(pi)` and zero force. A nonzero desired direct charge product at coincidence is singular and rejected. Nonzero displacements whose squared norm underflows to zero are rejected, not treated as exact coincidence.

The correction force uses a 24-term series for `alpha*r <= 1/2`, avoiding cancellation between `erf(x)` and `2*x*exp(-x*x)/sqrt(pi)`. Outside this small domain it uses the direct analytic expression. The energy uses ScalarMath's stable `erf` result. Force comparisons are independently differentiated from scalar energies.

## Kernel APIs

All numerical arguments/results are finite binary128-format `bytes16`. These arithmetic semantics are inherited from the pinned numerical modules and are not an IEEE-754 correctly rounded guarantee.

| Component | Construction and operations |
|---|---|
| `EwaldRealSpaceKernel` | `(math,scalar)`; `evaluate(d[3],chargeProduct,prefactor,alpha,cutoff) -> (energy,forceOnA[3])` |
| `EwaldReciprocalKernel` | `(math,scalar,elementary)`; `waveVector(mode[3],box[3],alpha,prefactor) -> (k[3],coefficient)`; `structureFactorTerm(position[3],charge,mode[3],box[3]) -> (qCos,qSin)`; `modeEnergy(A,C,S)`; `forceContribution(k,A,qCos,qSin,C,S)` |
| `EwaldCorrections` | `(math,scalar)`; `selfEnergy(charge,alpha,prefactor)`; `backgroundEnergy(totalCharge,box[3],alpha,prefactor)`; `exception(d[3],originalChargeProduct,desiredChargeProduct,prefactor,alpha) -> (energy,forceOnA[3])` |

`EwaldKernelBase` is an abstract validation helper and is not an additional deployed contract. Each concrete kernel exposes `numericalMath` and `scalarMath`; the reciprocal kernel also exposes `elementaryMath`. Constructors verify compatible arithmetic dependencies.

Real-space configuration requires `alpha*cutoff <= 16`, reflecting the scalar function's supported domain. Exception evaluation requires `alpha*r <= 16`. Reciprocal damping exponents must remain within ScalarMath's `[-256,256]` exp domain; unsupported terms cause a revert instead of being silently omitted. Mode components have magnitude at most 32 in this development implementation.

Reciprocal phases reduce coordinates in physical units before dividing by box length, then reduce the combined number of cycles before multiplying by `2*pi`. The per-axis input image ratio is bounded by `2^32`. This avoids passing unwrapped, arbitrarily large phases into the angular module. Finite precision can still affect large-coordinate reductions; fixture invariance is not a general error bound for every representable coordinate.

## Complete on-chain evaluator

`EwaldForceEvaluator(owner, modules)` takes this ordered tuple:

```text
(registry, dataset, math, scalar, elementary, geometry,
 realSpace, reciprocal, corrections)
```

All nine runtime hashes and numerical links are pinned. The protocol registry must include the eight non-registry modules, evaluator and output page. Deploy `WorkingStatePage(evaluator)` and call `bindOutputPage(page)` once as owner.

The owner calls `createSnapshotPage(writer)` to deploy canonical `WorkingStatePage` input storage. Only this evaluator's factory-created snapshot pages are accepted. A caller cannot satisfy the freeze condition merely by presenting arbitrary code that reports `isSealed = true`. The designated writer uploads the coordinate snapshot into a namespace and irreversibly seals it. This initial evaluator supports sealed snapshots; it does not read an independently mutable dynamics buffer through a claimed lock.

Registration is owner-only:

```text
registerRun(protocolId, Registration)
Registration = (datasetId, sourcePage, sourceNamespace,
                positionOffset, positionStride, alpha, maxMode)
```

Positions are three consecutive words at `positionOffset + atom*positionStride`, with stride at least 3. Source coverage is checked against the namespace capacity. The snapshot page and writer code hashes are bound and checked on each advancement. The frozen `PeriodicDataset` supplies atom count, charges, exceptions, box, cutoff and prefactor; its commitment is checked transitively. The source dataset may have other molecular parameters, but this evaluator computes only Coulomb terms.

The development limit is 2–1,024 particles, at most 4,096 exception records, reciprocal extent 1–32 and work limit 1–8. The maximum-corner damping calculation is checked during registration so unsupported reciprocal damping parameters cannot start a run. These limits do not establish support for the eventual solvated cardiac-myosin system size.

Anyone may call `advance(runId,workLimit)`; the caller cannot provide computed structure factors, forces or energies.

| Status | One work unit |
|---|---|
| Loading | Read and validate one coordinate/charge; add its self energy and charge sum |
| ValidatingExceptions | Validate one sorted, unique exception and populate a run-local lookup |
| RealPairs | Visit one unordered pair, skipping the real term only for registered exceptions |
| Exceptions | Add one corrected exception energy and pair forces |
| ModeSetup | Deterministically select one canonical mode and compute its wave vector/coefficient |
| StructureFactor | Add one particle's q*cos and q*sin; final particle commits this mode's energy |
| ModeForces | Add one particle's force using the complete structure factor |
| Background | Add the background term and seal output |
| Completed | No further advancement or writes |

Every atom's position remains unchanged for the entire force pass. All C/S accumulation completes before any force for that mode is evaluated. Transaction partitioning does not change mode order, atom order, pair order or summation order. A failed transaction rolls back all its accumulator, cursor and lookup writes; earlier successful transactions remain valid partial work.

Output capacity is `3*N+6` words: first all particle forces, then `[total,real,reciprocal,self,background,exceptions]` energies. `forceAt` and `energies` reject incomplete runs. Raw working-page reads remain available for inspection of partial progress. Final completion seals the output namespace. The evaluator is the complete electrostatic force pass. Its NVE integration is implemented separately by `EwaldDynamicsCoordinator`, described below; neither component is a free-energy estimator.

### Identity

Commitments use Solidity `abi.encode` and Keccak-256. Core configuration binds the ordered module tuple and nine runtime hashes. Output configuration adds the output page address/hash. The snapshot hash binds the complete registration tuple, source-page hash and writer address/hash. The run commitment binds:

```text
bytes32("ORVIA-EWALD-RUN-v1"), chainId, evaluatorAddress, runId,
protocolManifest, periodicDatasetCommitment, configurationHash, snapshotHash
```

The output namespace uses `bytes32("ORVIA-EWALD-STATE-v1"),chainId,evaluatorAddress,runId`. The commitment refers to an immutable, readable source namespace; it is not an off-chain hash substituted for coordinates.

## On-chain NVE integration

`EwaldDynamicsCoordinator(owner,modules)` uses the same ordered twelve-module bundle as `PeriodicDynamicsCoordinator`:

```text
(registry,dataset,math,integrator,bond,angle,torsion,lj,coulomb,
 elementary,geometry,nonbonded)
```

The coordinator takes complete Ewald electrostatics from its dedicated evaluator. Every call to `SwitchedNonbondedKernel` passes **zero charge product**, including direct exceptions; therefore that kernel supplies only quintic-switched ordinary LJ or unswitched direct exception LJ. Exclusions contribute no LJ. Bond, angle and torsion forces retain the existing nearest-image geometry and validation. The retained Coulomb module address identifies the switched kernel's dependency; it contributes zero electrostatic energy in this coordinator.

Configuration has a deliberate order:

1. Deploy the coordinator and bind `WorkingStatePage(coordinator)` with `bindWorkingPage`.
2. Deploy `EwaldForceEvaluator(coordinator,ewaldModules)` with the coordinator as owner.
3. Call the coordinator's `bindEwald(evaluator)` as its owner. It verifies shared registry, dataset, math, angular and geometry identities, creates a dedicated output page, binds it to the evaluator, and asks the evaluator to create a canonical snapshot page with the coordinator as writer.
4. Register a protocol containing the union of both module sets, both coordinators and all three working pages. The frozen data catalogs retain their existing transitive page checks.
5. Register a run with `registerExperiment(protocolId,datasetId,dt,steps,alpha,maxMode)` and advance with `advanceExperiment(runId,workLimit)`.

The working page has two buffers, each holding position/velocity/force, plus two energies (`18*N+2` words). Each force pass uses the following stages:

| Stage | Bounded operation |
|---|---|
| Bonded and ordinary pair passes | One bonded term or unordered LJ pair per work unit |
| Snapshot | Copy one atom's three coordinates into a new namespace; seal after the final atom |
| Register | Register the sealed snapshot with the frozen dataset, alpha and reciprocal extent |
| Ewald | Advance exactly one internal evaluator work unit, or recognize an independently completed evaluator run |
| Merge | Add one atom's complete electrostatic force; add total electrostatic energy exactly once |
| Kick | Finish one atom's Verlet velocity; publish the new buffer only after every atom finishes |

Initialization also waits for a complete Ewald merge before exposing `stateAt`. `ewaldParameters` returns the initialization flag, current evaluator run ID and snapshot namespace. Before initialization, `runInfo.potentialEnergy` is a zero placeholder and must be interpreted with that flag. After initialization, active position, velocity, force and energy remain the previous committed state during every partial drift, force calculation, snapshot, Ewald evaluation, merge and final kick. A failure cannot publish a partially computed timestep. The final kick of the final atom flips the active buffer; completing the requested step count seals the working namespace.

No caller uploads a force, structure factor or result. Permissionless keepers may advance either the coordinator or its current evaluator, and the coordinator safely recognizes a completed evaluator result. Run identity binds chain/address, protocol, frozen dataset, configuration, timestep, step count, alpha, reciprocal extent and state namespace. The configuration includes both coordinator dependencies, evaluator configuration and all three pages' code hashes. Snapshots cannot be mutated after sealing. Every advance rechecks registered executable and dataset identities.

This version intentionally copies and preserves one coordinate snapshot and one force-output namespace for every force pass. At `T` steps it performs `T+1` electrostatic evaluations and retains `(T+1)*(6*N+6)` words of snapshot/result capacity in addition to the double buffer. It does not yet implement a cheaper locked-buffer path, a neighbor-list real-space pass, PME, thermostat, constraints or barostat in this coordinator. Caps remain 1,024 atoms, 4,096 steps, reciprocal extent 32 and work limit 8; those caps and the all-pairs/explicit-mode cost do not qualify it for the eventual solvated protein workload.

The coordinator's optimized Shanghai runtime exceeds Ethereum's 24,576-byte EIP-170 limit. Its local integration test explicitly enables unlimited runtime size, then asserts it is below the separately assumed 96 KiB target limit. That relaxation is a local test setting, **not verification of a live Robinhood chain limit or a successful deployment**. Deployment tooling must independently establish target limits and reproduce the artifact size.

## Validation and truncation evidence

`reference/generate_ewald_reference.py` uses mpmath at 90 digits. Forces are independent derivatives of scalar energies. The fixture contains two neutral charges, one real pair, thirteen reciprocal half-space modes, self correction and zero background; a second calculation uses a direct exception. Separate vectors test nonneutral background, tiny-distance exclusion stability and a nonzero erfc tail near x=16.

The Python tests check independent gradients, net internal force, lattice translation, reciprocal sign-pair completeness, exact intracell exception replacement, coincidence limits, alpha independence of a larger real/reciprocal lattice sum, and separate real/reciprocal truncation behavior. `reports/ewald_truncation_reference.json` is reference-only evidence, distinct from contract agreement.

For the small fixture, alpha=0.75, real cutoff=1.75 and mode extent 1 give an energy error of about 0.00356 against the larger lattice reference. Increasing only the reciprocal extent to 6 leaves about 0.000413 from the real-space cutoff. The total error is not monotonically reduced by changing only one side because real and reciprocal truncation errors can partially cancel. Passing an EVM comparison against the same finite sum does not remove either truncation error.

The component EVM suite compares primitive and complete evaluator results, verifies bitwise equality across transaction partitions, frozen source requirements, rollback and independently reconstructed commitments. A separate dynamics oracle (`generate_ewald_dynamics_reference.py`) differentiates the total Ewald, nonzero harmonic-bond and nonzero LJ energy at 90 digits, then applies velocity Verlet. Its ordinary two-step and direct-exception one-step fixtures exercise complete force integration. The dynamics EVM suite also checks alternate transaction partitions, partial merge/kick visibility, code-hash failure and bad-mass transaction rollback. The two-atom NVE fixtures do not exercise nonempty angle/torsion streams or a kind-1 exclusion through a complete trajectory; those are explicit integration coverage limits. Its actual pass counts and gas measurements are recorded in the validation reports. Snapshot advancement gas excludes deployment, input uploads and registration; local gas is not a Robinhood fee quote.

## Sources

- [OpenMM standard-force theory, Ewald section](https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html): real, reciprocal and self decomposition; finite cutoffs and accuracy controls.
- [LAMMPS kspace_style](https://docs.lammps.org/kspace_style.html): three-dimensional periodic Ewald and conducting boundary conventions.
- [LAMMPS group/group electrostatics](https://docs.lammps.org/compute_group_group.html): explicitly declared uniform neutralizing-background interpretation for nonneutral systems.

Equations are written here in the physical wave-vector convention; the half-space coefficient and analytic forces are derived from the scalar energy. Sources were checked on 2026-11-02. The independent reference does not call OpenMM or LAMMPS, and therefore is not a cross-engine molecular benchmark.
