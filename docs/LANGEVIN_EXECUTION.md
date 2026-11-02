# Deterministic on-chain BAOAB execution

`LangevinDynamicsCoordinator` combines the periodic cutoff Hamiltonian and resumable neighbor lists with BAOAB stochastic dynamics. Force evaluation, hash-derived normal draws, thermostat operations, integration and working state execute in contracts. Callers submit a run ID and bounded work limit, never forces, random draws or computed positions.

This path retains the conducting-limit reaction-field development Hamiltonian. It does not include Ewald/PME, molecular constraints, a barostat, alchemical changes, a prepared cardiac-myosin system or free-energy analysis. A short deterministic reference trajectory is an implementation check, not validation of the sampled equilibrium distribution.

## Modules and configuration

Construction is `LangevinDynamicsCoordinator(owner, modules)`, with the tuple

```text
(registry, dataset, math, integrator, bond, angle, torsion, lj, coulomb,
 elementary, geometry, nonbonded, scalar, random)
```

`integrator` is `LangevinBAOABKernel`; `scalar` is `ScalarMath`; `random` is `CounterRandom`. Existing module meanings are unchanged. All fourteen runtime code hashes are pinned. Every numerical module must expose the selected arithmetic dependency; angular and random modules bind the selected elementary functions; the integrator and random module bind the scalar functions. Direct LJ/Coulomb dependencies are checked as in the periodic engine. `modules()` returns the complete struct as one tuple.

Deploy a writer-restricted `WorkingStatePage` and `NeighborList` for this coordinator, then bind them once with `bindWorkingPage(page, neighbors)`. Their runtime hashes and the neighbor list's writer, geometry, arithmetic and state-page identities are included in configuration validation. The registered protocol must include the executable modules, coordinator and both state/list contracts.

## Registration and immutable streams

```text
registerExperiment(protocolId, datasetId, Parameters)
Parameters = (bytes16 dt, uint32 steps, bytes16 skin,
              bytes16 friction, bytes16 kT,
              bytes32 seed, bytes32 streamId, uint32 replica)
```

Only the owner registers a run. Timestep, skin and thermal energy kT must be positive and finite; friction is finite and nonnegative; `friction*dt` cannot exceed 256. The stream ID must be nonzero. A zero seed is valid and still deterministic. The development bounds remain 2–1,024 atoms and 1–4,096 timesteps, with at least one input bond. The neighbor list enforces its skin and geometry bounds.

The molecular input and per-atom mass remain frozen in the paged dataset. `stochasticParameters(id)` returns `(friction, kT, seed, streamId, replica)`; the other status, parameter and state APIs retain the neighbor coordinator's ordering.

The first timestep uses counter step 0. For atom i and completed timestep counter s, the coordinator invokes

```text
normalPair(seed, streamId, replica, uint64(s), uint64(2*i))
normalPair(seed, streamId, replica, uint64(s), uint64(2*i+1))
```

The three Cartesian draws are the first pair's cosine and sine components plus the second pair's cosine component. The unused fourth component is deliberately discarded. No mutable RNG state is advanced, so retrying a reverted transaction reproduces the same draws. Run ID, caller, contract address, block values and transaction batch size do not change the stochastic stream.

Separate runs with the same seed, stream ID and replica intentionally share draws, enabling exact partition tests or an explicitly declared common-random-number design. Independent scientific repeats must register distinct stream/seed/replica combinations; the engine does not claim that duplicate registered tuples are independent repeats. At zero friction, the coordinator skips normal generation and exactly follows its velocity-Verlet limit on the validated finite-domain fixtures.

## State barriers and neighbor lists

The stage values and neighbor-list preparation algorithm match `NeighborDynamicsCoordinator`: initialization and validation, initial list preparation, complete initial force evaluation, Drift, next-list preparation, complete next-force evaluation, Kick, then atomic commit. The Drift stage now performs BAOAB's B–A–O–A sequence for one atom into the inactive buffer. The Kick stage performs the final B operation using the complete new force vector. Stored velocities at committed timesteps are on-step BAOAB velocities.

One advancement accepts 1–8 work records. Neighbor construction/reuse checks remain bounded and consume records. Stochastic draws add bounded computation to an atom's drift record. The current molecular buffer stays untouched until the final kick flips it. Every write, including neighbor preparation and any step commit earlier in a failed transaction, reverts with that transaction. Final completion seals the working namespace.

The two-buffer layout remains `18*N+2` words. The active state and next/trial state are separate; sample-history retention and ensemble diagnostics are not provided by this coordinator.

## Commitments

All hashes use Solidity `abi.encode` and Keccak-256. The core configuration hashes the fourteen-field module tuple and `bytes32[14]` code hashes. The final configuration hashes that core with the state-page and neighbor-list addresses and runtime hashes.

```text
namespace = keccak256(abi.encode(bytes32("ORVIA-LANGEVIN-STATE-v1"),
    uint256(chainId), address(coordinator), uint256(runId)))
commitment = keccak256(abi.encode(bytes32("ORVIA-LANGEVIN-RUN-v1"),
    uint256(chainId), address(coordinator), uint256(runId), bytes32(protocolManifest),
    bytes32(datasetId), bytes32(datasetCommitment), bytes32(configurationHash),
    Parameters(dt, steps, skin, friction, kT, seed, streamId, replica), bytes32(namespace)))
```

Every thermostat value and stream identifier is therefore immutable for a registered run. An implementation change requires another deployed and registered protocol.

## Evidence and chain limits

`test/langevin-dynamics.test.mjs` compares a two-atom, three-step BAOAB trajectory with `reference/scalar_random_trajectory.py`. The reference differentiates independent scalar molecular energies at 100 decimal digits and transforms independently ABI-encoded Keccak midpoint uniforms. It does not read contract-produced forces or normals. Separate checks compare exact output bytes across run IDs/batching, recover the existing velocity-Verlet trajectory at zero friction, reconstruct module/run commitments independently, and reject invalid thermostat/stream registration.

The coordinator runtime is larger than Ethereum's 24 KiB limit. Its dedicated local Ganache fixture enables unlimited contract size and independently asserts runtime below the documented 96 KiB Robinhood planning limit. This setting is a local development accommodation, not proof of target-chain behavior or a successful Robinhood deployment. The compiler report owns the actual measured size. Target-chain configuration and deployment simulation remain separate requirements.

`reports/langevin_validation.json`, `reports/langevin_reference.json` and `reports/langevin_execution_gas.json` record completed trajectory checks and local advancement gas. Deployment, input uploads and registration are excluded from advancement totals. No complete-protein cost or scientific convergence claim follows from this fixture.
