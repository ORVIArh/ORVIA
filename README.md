# ORVIA

### Onchain Research through Verified Inference and Analysis

Open molecular research on Robinhood Chain. Our goal is to make scientific calculations reproducible from public inputs, with the computation, intermediate state and analysis inspectable on-chain.

[Progress](STATUS.md) · [Roadmap](ROADMAP.md) · [Research log](RESEARCH_LOG.md) · [Architecture](docs/ARCHITECTURE.md) · [Release requirements](docs/PRODUCTION_GAPS.md)

**Development checkpoint v0.5.1. Mainnet readiness remains false.** The original v0.5.0 archive was recovered and every packaged payload hash verified on 2 November 2026. Changes in this checkpoint receive a new source-bound validation run; the authoritative result is [validation_summary.json](reports/validation_summary.json).

ORVIA targets fully on-chain molecular calculations on Robinhood Chain. The proposed first experiment compares compound 17 with aficamten in a declared cardiac-myosin state. Registered molecular inputs, numerical work, simulation state and analysis are intended to remain in contracts. Permissionless bounded transactions advance work; swap/pool triggers are deferred.

**This is a tested development system, not a mainnet-ready release or a binding-free-energy result.** The package contains 44 deployable experimental contract types and a 64-instance production design. All 64 production slots remain planned. No Robinhood contracts have been deployed. Alternative coordinators do not automatically form one combined production engine, and contract count does not measure scientific quality or computational throughput.

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
| Alchemical/MC math | Two-endpoint softcore LJ plus exchange/volume acceptance formulas | No complete alchemical Hamiltonian, proposal engine or integrated sampler |
| Analysis | Frozen reduced potentials, general MBAR, overlap/weight ESS, chronological correlation diagnostics and preregistered repeat SEM | Synthetic writer fixtures; production sampler connection and correlation-aware sample selection missing |
| Cost and deployment | Bitwise-equivalent inline pair integration, local gas benchmarks, source/runtime checks and unsigned fee tools | No complete prepared-system budget, Robinhood execution-client rehearsal or production fee quote |

See [the manifest](data/contract_manifest.json) for exact source names and associations. A source associated with a slot is a candidate, not evidence that the production slot is finished.

## Reproduce the checks

The recovered v0.5.0 baseline recorded **205 Node/EVM tests and 63 independent Python reference tests passing** at `2026-11-01T20:38:21.755Z`. All 256 archived payloads matched their packaged SHA-256 hashes when recovered. Those are historical baseline results. Current-version results, exact inputs, compiler outputs, nine logs and generated evidence are bound by [validation_summary.json](reports/validation_summary.json); the separate mainnet gate remains false.

Use Node.js/npm and Python 3. Dependencies are pinned in `package-lock.json` and `requirements-research.txt`.

```bash
npm ci
python3 -m venv .venv-research
.venv-research/bin/python -m pip install -r requirements-research.txt
ORVIA_RESEARCH_PYTHON=.venv-research/bin/python npm run check
```

Compilation uses Solidity 0.8.26, optimizer 200, Shanghai EVM and no viaIR. EVM tests use in-process Ganache chain 31337. They require no mainnet account or RPC. Four experimental coordinators/minimizers exceed Ethereum's 24 KiB runtime ceiling; their dedicated tests explicitly relax local size enforcement and assert the documented Robinhood planning ceiling. This is not a Robinhood fork test. Compiler warnings are retained in the size report.

The runner discovers all EVM and Python tests and performs nine groups: compilation, EVM components/integrations/deployment rehearsal, independent references, architecture, structure, ligand identity, receptor preparation, scientific readiness and packaged alternative-model provenance. The actual completed results are in [validation_summary.json](reports/validation_summary.json) and its logs. Tests cover high-precision scalar-energy differentiation, independent constraint/MBAR/correlation solvers, deterministic transaction partitioning, frozen identities, intermediate-state barriers, failure/restart behavior and cross-contract rollback. Small fixtures do not validate a full protein calculation.

```bash
node scripts/deploy.mjs --readiness
python3 scripts/validate_manifest.py --require-ready
```

Both readiness commands are expected to reject this development package. A passing local test suite must not bypass missing production capabilities. After a full successful check, `python3 scripts/package.py` builds and hash-verifies the source-and-validation archive. Installed dependencies and private local environment settings are excluded.

## Scientific and computational limits

The reproducible original receptor mask contains 6,032 observed heavy-atom rows, with 65 missing residues and incomplete TRP130 chemistry. A unique 24-heavy-atom ligand map and derived compound-17 heavy pose are available. They are external model-input candidates, not complete force-field preparation. Public Mg–ADP–phosphate models provide an evidenced alternative to the original vanadate state, but require an explicit model choice and compatible target parameterization. Functional ATPase IC50 values must not be presented as Kd or a validated affinity result.

Most dynamics paths are capped at 1,024 atoms and 4,096 steps. Full solvated myosin exceeds this development scope. Scaling requires bounded distributed data/state access and measured scientific workload, not just larger constants or more contract addresses. [The workload report](docs/WORKLOAD_FEASIBILITY.md) shows very large illustrative pair-only costs; it is not a measured myosin estimate or Robinhood throughput forecast. [Inline pair arithmetic](docs/COMPUTE_COST.md) now has an explicit integration path in the neighbor NVE coordinator. Its trajectory and gas tests remain small-fixture evidence, and other coordinators retain their original external pair path.

The targeted neighbor suite passed **11 tests**. Its identical four-atom, three-step trajectory used **1.92% less advancement gas** with inline pair arithmetic (65,446,162 versus 66,727,850 gas). That complete-fixture result is distinct from the standalone pair microbenchmark's 51–53% saving. Neither is a measured full-myosin workload or mainnet fee estimate; the current complete source-bound suite is recorded separately in the validation summary.

The target is Robinhood mainnet chain 4663. A provider listed in Robinhood's documentation now passes the [read-only network preflight](reports/mainnet_preflight.json). A [block-pinned local state-fork smoke check](docs/FORK_SMOKE.md) exercises two numerical kernels. It uses Ganache's Ethereum Shanghai rules and does not validate Robinhood Nitro execution rules, full molecular production, network throughput or mainnet fees. No signing key is included or requested.

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
