# ORVIA

### Onchain Research through Verified Inference and Analysis

Open molecular research on Robinhood Chain. Our goal is to make scientific calculations reproducible from public inputs, with the computation, intermediate state and analysis inspectable on-chain.

[Progress](STATUS.md) · [Roadmap](ROADMAP.md) · [Research log](RESEARCH_LOG.md) · [Architecture](docs/ARCHITECTURE.md) · [Release requirements](docs/PRODUCTION_GAPS.md)

**Current snapshot: v0.6.0-dev, integration in progress.** The [current validation summary](reports/validation_summary.json) is incomplete and does not claim a full-suite pass. The historical v0.5.1 checkpoint passed 212 Node/EVM tests, 63 Python references and all nine check groups; that result does not validate subsequent changes. Mainnet readiness remains false.

ORVIA targets fully on-chain molecular calculations on Robinhood Chain. The proposed first experiment compares compound 17 with aficamten in a declared cardiac-myosin state. Registered molecular inputs, numerical work, simulation state and analysis are intended to remain in contracts. Permissionless bounded transactions advance work; swap/pool triggers are deferred.

**This is a development system, not a mainnet-ready release or a binding-free-energy result.** New candidates connect sharded state, a finite hybrid Hamiltonian, unconstrained sampling and analysis. They extend the older component inventory and still require current complete validation. The architecture describes 64 planned production slots; none is claimed complete and none has been deployed to Robinhood. Contract count does not measure scientific quality or computational throughput.

## Implemented and exercised

| Area | Current implementation | Boundary |
|---|---|---|
| Numerics | Binary128-format arithmetic; bounded angular/log/exp/error functions; counter-addressed uniforms and normals | Declared approximation/domain semantics, not universal correctly rounded arithmetic |
| Forces and inputs | Bond, angle, proper torsion, LJ, direct/RF electrostatics; frozen paged datasets; fixed orthorhombic geometry | Complete chosen protein/ligand force field and preparation remain unfinished |
| Neighbor dynamics | Resumable Verlet-list checking/rebuilding, NVE timesteps and selectable pinned inline pair runtime | Rebuild screens all pairs; development size/step caps; measured savings concern a four-atom fixture |
| Stochastic dynamics | Counter-based BAOAB Langevin with neighbor lists | Separate from constrained and Ewald paths; full ensemble validation remains required |
| Constraints | Pair SHAKE/RATTLE primitives, bounded solver/catalog and constrained NVE | Separate from the thermostat/Ewald paths; whole-molecule coordinate restrictions |
| Electrostatics | Direct reciprocal Ewald, real/self/background/exception terms, frozen-snapshot force passes and NVE integration | Direct sums, not PME; small truncation fixtures do not establish full-system accuracy |
| Minimization | Complete periodic force passes, RMS gradient and Armijo backtracking | Development Hamiltonian and explicit convergence limits |
| Alchemical/MC math | Finite endpoint-mixed Hamiltonian and connected unconstrained BAOAB sampling candidate, plus exchange/volume acceptance primitives | Small-fixture evidence; complete prepared-model coverage, constraints and physical protocol acceptance remain missing |
| Analysis | Computed cross-state energies, canonical sample chronology, correlation-based selection and MBAR connected in the development pipeline | Full-system equilibration, sampling, overlap and repeat uncertainty remain unvalidated |
| Cost and deployment | Bitwise-equivalent inline pair integration, local gas benchmarks, source/runtime checks and unsigned fee tools | No complete prepared-system budget, Robinhood execution-client rehearsal or production fee quote |

See [the manifest](data/contract_manifest.json) for exact source names and associations. A source associated with a slot is a candidate, not evidence that the production slot is finished.

## Reproduce the checks

The historical v0.5.1 run finished at `2026-11-02T04:59:25.175Z`: **212 Node/EVM tests and 63 independent Python reference tests passed**, with zero failed, cancelled or skipped Node tests. Its nine groups and integrity verification bound 159 inputs, two compiler outputs, 36 reports and nine logs. [The research log](RESEARCH_LOG.md) preserves that checkpoint and the recovered v0.5.0 baseline. The current v0.6.0-dev source has changed since the later component checkpoint and needs a new complete run; its summary is deliberately marked incomplete.

Use Node.js/npm and Python 3.12 for the pinned research dependencies. This continuation was tested with Node.js 24.22.1 and CPython 3.12.14. Dependencies are pinned in `package-lock.json` and `requirements-research.txt`.

```bash
npm ci
python3.12 -m venv .venv-research
.venv-research/bin/python -m pip install -r requirements-research.txt
ORVIA_RESEARCH_PYTHON=.venv-research/bin/python npm run check
```

The new native ligand-preparation checks additionally need a separate preparation environment with the declared AmberTools/OpenMM dependencies; set `ORVIA_PREPARATION_PYTHON` to that environment's Python. See [ligand preparation](docs/LIGAND_PREPARATION_v0_1.md). Do not combine its package versions with the pinned independent-reference environment.

Compilation uses Solidity 0.8.26, optimizer 200, Shanghai EVM and no viaIR. EVM tests use in-process Ganache chain 31337. They require no mainnet account or RPC. Four experimental coordinators/minimizers exceed Ethereum's 24 KiB runtime ceiling; their dedicated tests explicitly relax local size enforcement and assert the documented Robinhood planning ceiling. This is not a Robinhood fork test. Compiler warnings are retained in the size report.

The runner discovers all EVM and Python tests and performs nine groups: compilation, EVM components/integrations/deployment rehearsal, independent references, architecture, structure, ligand identity, receptor preparation, scientific readiness and packaged alternative-model provenance. The actual completed results are in [validation_summary.json](reports/validation_summary.json) and its logs. Tests cover high-precision scalar-energy differentiation, independent constraint/MBAR/correlation solvers, deterministic transaction partitioning, frozen identities, intermediate-state barriers, failure/restart behavior and cross-contract rollback. Small fixtures do not validate a full protein calculation.

```bash
node scripts/deploy.mjs --readiness
python3 scripts/validate_manifest.py --require-ready
```

Both readiness commands are expected to reject this development package. A passing local test suite must not bypass missing production capabilities. After a full successful check, `python3 scripts/package.py` builds and hash-verifies the source-and-validation archive. Installed dependencies and private local environment settings are excluded.

## Scientific and computational limits

The reproducible original receptor mask contains 6,032 observed heavy-atom rows, with 65 missing residues and incomplete TRP130 chemistry. A unique 24-heavy-atom ligand map and derived compound-17 heavy pose are available. They are external model-input candidates, not complete force-field preparation. Public Mg–ADP–phosphate models provide an evidenced alternative to the original vanadate state, but require an explicit model choice and compatible target parameterization. Functional ATPase IC50 values must not be presented as Kd or a validated affinity result.

Historical dynamics coordinators retain their 1,024-atom and 4,096-step caps. The new [sharded state](docs/SHARDED_STATE.md) and [connected molecular pipeline](docs/MOLECULAR_PIPELINE.md) implement bounded partitions, immutable snapshots and absolute-counter continuation beyond those historical limits. This does not establish a feasible or validated full solvated-myosin run. [The workload report](docs/WORKLOAD_FEASIBILITY.md) contains illustrative pair-only costs, not a complete campaign quote or Robinhood throughput forecast. [Inline pair arithmetic](docs/COMPUTE_COST.md) has a separate integration path in neighbor NVE, with small-fixture trajectory and gas evidence.

The targeted neighbor suite passed **11 tests**. Its identical four-atom, three-step trajectory used **1.92% less advancement gas** with inline pair arithmetic (65,446,162 versus 66,727,850 gas). That complete-fixture result is distinct from the standalone pair microbenchmark's 51–53% saving. Neither is a measured full-myosin workload or mainnet fee estimate; the current complete source-bound suite is recorded separately in the validation summary.

The target is Robinhood mainnet chain 4663. A provider listed in Robinhood's documentation now passes the [read-only network preflight](reports/mainnet_preflight.json). A [block-pinned local state-fork smoke check](docs/FORK_SMOKE.md) exercises two numerical kernels. It uses Ganache's Ethereum Shanghai rules and does not validate Robinhood Nitro execution rules, full molecular production, network throughput or mainnet fees. A separate [target-node read-only probe](docs/TARGET_NODE_EXECUTION.md) also returned the exact runtimes and numerical bytes for two kernels through the Robinhood provider. This is supplementary kernel evidence, outside the offline suite, and does not validate the full molecular pipeline or transaction fees. No signing key is included or requested.

## Detailed evidence

- [Status](STATUS.md), [production gaps](docs/PRODUCTION_GAPS.md), [architecture](docs/ARCHITECTURE.md), [mainnet readiness](docs/MAINNET_READINESS.md)
- [Neighbor list](docs/NEIGHBOR_LIST.md), [Langevin](docs/LANGEVIN_EXECUTION.md), [stochastic numerics](docs/STOCHASTIC_NUMERICS.md)
- [Constraints](docs/CONSTRAINTS.md), [constrained dynamics](docs/CONSTRAINED_DYNAMICS.md), [minimization](docs/MINIMIZATION.md), [Ewald](docs/EWALD.md)
- [Alchemical/MC primitives](docs/ALCHEMICAL_AND_MC.md), [free-energy analysis](docs/FREE_ENERGY_ANALYSIS.md), [time-series diagnostics](docs/TIMESERIES_DIAGNOSTICS.md)
- [Scientific readiness](docs/SCIENTIFIC_READINESS.md), [original protocol](docs/PROTOCOL_ORVIA_001.md), [structure audit](docs/SOURCE_AUDIT.md), [ligand audit](docs/INPUT_DECISIONS_v0_2.md)
- [Retained finite dynamics](docs/DYNAMICS_EXECUTION.md), [periodic baseline](docs/PERIODIC_EXECUTION.md), [working-state schema](docs/WORKING_STATE.md)

## Third-party acknowledgement

This product includes software developed by ABDK Consulting.

The pinned vendored ABDK source retains its BSD-4-Clause license and provenance. Original Solidity components carry MIT SPDX identifiers. Scientific-source attribution is recorded in the audits. Two selected public model members are redistributed in compressed form under CC BY 4.0 with provenance; the full source archive is excluded. Complete publisher supplementary PDF/CSV files for the medicinal-chemistry article are not redistributed.
