# Frozen-frame constraint components

`FullModelConstraintCatalog` and `FullModelConstraintSolver` are standalone engineering components for the planned K17/K18 roles. They use the existing `DistanceConstraintKernel` (K19), binary128 `FloatMath`, sealed full-model input banks, and frozen banked state. They deploy no storage children and write no pipeline-owned state.

These components do not yet establish a production constrained molecular integrator. In particular, projecting the output of the existing combined BAOAB `begin` operation once is insufficient: the integrator must expose the appropriate kick, drift, and thermostat stages and apply the selected constraint protocol at those stages. Parameter acceptance, the physical constraint selection, periodic imaging policy, and production convergence thresholds remain explicit scientific decisions.

## Constraint catalog

Constructor: `FullModelConstraintCatalog(owner, topology, math)`.

The topology must be a sealed `AlchemicalTopologyCatalog` using the same immutable math implementation. Input records are canonical triples `(uint32 atomA, uint32 atomB, binary128 targetDistance)` in an existing sealed input stream. Integers and binary128 encodings occupy the low bits of their 32-byte words; high bits are rejected. The stream role must be `keccak256("ORVIA.FullModelConstraintTriples.v1")`, exposed as `CONSTRAINT_STREAM_ROLE`.

The owner calls `createSet(id, topologyId, streamId, count, policyHash)`. The stream must contain exactly `3 * count` words with full append coverage. Counts are nonzero, bounded by the number of unique atom pairs and uint64 stream arithmetic. `policyHash` must be nonzero and identifies the declared physical constraint-selection policy; it is not an automatic scientific approval.

Anyone may execute `advance(id, work)` for 1–8 records. Validation requires `a < b < atomCount`, strictly increasing lexicographic pair keys, and finite positive target distances. Duplicate pairs, reversed pairs, noncanonical encodings, and nonpositive/nonfinite distances reject. Only after exact coverage does `assertSet(id)` return the commitment. `constraintAt(id, index)` reads the authenticated sealed stream; records are not copied to a second per-constraint store.

The commitment binds the topology, stream, role, physical policy, atom count, constraint count, canonical validation completion, catalog identity, chain, and dependency code hashes. No old 1,024- or 65,536-atom fixture cap remains. The shared topology/state layout still requires `9 * atoms + 1 <= uint32.max`.

## Solver and integration interface

Constructor: `FullModelConstraintSolver(writerPipeline, math, kernel, catalog)`.

Only that code-pinned writer may call `registerProblem(id, Params)`. `Params` contains:

| Field | Meaning |
| --- | --- |
| `setId` | Complete catalog constraint set |
| `mode` | `Position=0` or `Velocity=1` |
| `sourcePage` | Must equal `writerPipeline.statePage()` and identify storage owned by that writer |
| `anchorSnapshot` | Frozen old positions for SHAKE; frozen corrected positions for RATTLE |
| `trialSnapshot` | Frozen trial positions or velocities |
| `sourceProtocolHash` | Nonzero binding to the caller's selected protocol/stage identity |
| `positionTolerance` | Finite, strictly positive relative squared-distance tolerance, less than 1 |
| `velocityTolerance` | Finite, strictly positive radial velocity residual tolerance, units inverse time |
| `maxSweeps` | 1–4,096 complete correction/checking sweep pairs |

Snapshot namespaces must be sealed snapshots with nonzero commitments and exactly `9 * atoms + 1` words. Each atom occupies position words 0–2, velocity words 3–5, and force words 6–8; the final word is energy. The solver never consumes caller-supplied runtime position, force, mass, or projection arrays. Masses come from endpoint A's sealed particle stream; topology validation requires identical positive endpoint masses.

For velocity mode, both snapshot identifiers must be identical. This ensures the RATTLE geometry and trial velocities come from the same frozen corrected-position frame. For position mode, the old anchor geometry must already satisfy the declared position tolerance. RATTLE likewise rejects position geometry outside that tolerance.

Atoms touched by constraints are loaded lazily into problem-specific mappings. Unconstrained atoms remain unchanged and are read from the frozen trial frame. Each subsequent work record re-reads its source atoms and masses so touched bank code checks remain active. All top-level dependencies and snapshot bindings are checked before progress or solution access. Dependency/read failures revert the transaction; they cannot be disguised as numerical nonconvergence.

Anyone may call `advance(id, work)` for 1–8 records. The ordered algorithm performs one canonical mass-weighted SHAKE or RATTLE correction pass, then a separate full residual pass against the completed configuration. This prevents a later coupled correction from invalidating an earlier bond unnoticed. Results are identical across work partitions. An acceptable constraint is left unchanged during its correction visit, but position mode always enforces the local branch `oldDisplacement · currentDisplacement > 0`, including when the length residual is already zero.

Statuses are `Missing=0`, `Correcting=1`, `Checking=2`, `Converged=3`, `Failed=4`. `problemInfo` exposes the current cursor, completed sweep count, maximum residual, explicit failure selector, and commitments. A known kernel/geometry/arithmetic domain error records terminal `Failed`; unknown errors and insufficient gas revert instead. Exhausting `maxSweeps` with a residual above tolerance is terminal failure with no output commitment. There is no reset or recovery that silently substitutes a result.

Only after `Converged` do `assertSolution(id)`, `solutionAt(id, atom)`, and `correctionAt(id, atom)` succeed. The correction is the projected position/velocity minus the original frozen trial value. The output commitment binds inputs, protocol hash, tolerances, ordered numerical transcript, completed sweep count, and maximum residual. It is not a Merkle root of an independently uploaded output array.

The pipeline must import outputs in bounded atom batches and keep its own final commit barrier. The solver has no delegation to mutate the state router. Campaign/registry protocol authorization must be enforced by the pipeline before registration. A nonzero `sourceProtocolHash` alone does not enforce that external registry relationship.

## Equations and geometry policy

Use displacement `d = positionB - positionA`. Position residual is `abs(dot(d,d) - target^2) / target^2`. Velocity residual is `abs(dot(d, velocityB - velocityA)) / dot(d,d)`. The position tolerance and velocity tolerance therefore have different units and must not be substituted for one another.

The kernel applies opposite mass-weighted corrections with weights `massB / (massA + massB)` to atom A and `-massA / (massA + massB)` to atom B. This preserves the mass-weighted position sum for SHAKE and total linear momentum for RATTLE, subject to numerical rounding. Independent tests check both invariants with unequal masses.

Coordinates must be consistently unwrapped in a fixed orthorhombic box. Every constrained anchor displacement and every current/corrected position displacement must have absolute components strictly below the corresponding half-box length. Exact half-box ties, implicit image changes, flipped SHAKE roots, singular geometry, and nonfinite arithmetic fail closed. This is an explicit supported domain; the solver does not infer images or repair wrapped molecules.

If a chosen integrator updates velocity after a SHAKE drift, the duration in `(correctedPosition - trialPosition) / driftDuration` must be that actual drift substep's duration. This component returns the numerator only. It does not choose BAOAB stage order, insert an unregistered timestep, or claim a single full-step projection implements constrained BAOAB.

## Validation scope

Run from the repository root:

```sh
ORVIA_RESEARCH_PYTHON=/Users/abhijith/Documents/ChatGPT/AURA/tools/envs/preparation/bin/python node --test test/full-model-constraints.test.mjs
```

The focused test compiles only its dependency graph in memory with pinned solc 0.8.26, optimizer 200, and Shanghai settings. It never writes the global build artifacts, accesses a wallet, or submits a public transaction. Its report is `reports/full_model_constraints_validation.json` and is invalidated before compilation; source, test, and reference hashes are checked again before reporting success.

The main fixture uses a real validated three-atom topology, real 96-bank input catalog, and real frozen banked state. It covers coupled three-dimensional constraints with unequal masses, complete residual sweeps, exact work-partition replay, source immutability, authorization, invalid inputs, reversed bonds including exact-length reversal, half-box boundaries, iteration failure, dependency tampering, and insufficient gas rollback. An independent 110-digit mpmath reference uses the direct quadratic SHAKE root, verifies the projected values and sweep count, and checks residuals and mass-weighted conservation.

A separate index-range case declares 132,936 atoms using **synthetic topology metadata** and stores/evaluates only two high-index atoms in real sparse banked state. It demonstrates integer routing and capacity beyond the old fixture cap, plus unchanged unconstrained output. It is explicitly not a fully uploaded, chemically validated, or dynamically tested 132,936-atom model.

Consult the report's `passed` and source hashes for the current result. Local gas measurements exclude input upload, the full deployed molecular architecture, and production trajectory execution; they must not be presented as the full-model campaign cost.

The completed focused run passed all nine check groups in 474.4 seconds. Its local measurements were:

| Component | Runtime bytes | Deployment gas |
| --- | ---: | ---: |
| Full-model constraint catalog | 7,514 | 1,690,690 |
| Full-model constraint solver | 17,792 | 3,917,132 |
| Existing distance constraint kernel | 5,298 | 1,201,946 |

The three-atom position case converged in 26 sweeps; executing one record per transaction used 156 transactions and 90,444,524 gas. The velocity case converged in 29 sweeps; eight records per transaction used 22 transactions and 51,270,178 gas. These are expensive synthetic projections, not evidence that a full molecular campaign is economically practical.

The independent reference found maximum absolute solution errors of approximately `7.545e-34` for position and `1.320e-33` for velocity. Mass-weighted conservation errors were approximately `5.876e-33` and `1.160e-32`, respectively. Final relative squared-distance and radial velocity residuals were approximately `7.650e-13` and `8.291e-13` against the synthetic `1e-12` tolerances. Those tolerances are test inputs, not approved production settings.
