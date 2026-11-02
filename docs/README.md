# Documentation

ORVIA explores reproducible molecular computation on Robinhood Chain. Start with the research question, inspect the implementation, then follow the evidence.

**This is a development checkpoint.** Component tests do not establish a complete prepared-myosin simulation, a binding-free-energy result or mainnet readiness.

[Project home](../README.md) · [Current status](../STATUS.md) · [Roadmap](../ROADMAP.md) · [Research log](../RESEARCH_LOG.md) · [Contributing](../CONTRIBUTING.md)

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the project and its boundaries | [Architecture](ARCHITECTURE.md) and [production gaps](PRODUCTION_GAPS.md) |
| Understand the proposed experiment | [ORVIA-001 protocol](PROTOCOL_ORVIA_001.md) and [scientific readiness](SCIENTIFIC_READINESS.md) |
| Review the published checkpoint | [Development checkpoint](DEVELOPMENT_CHECKPOINT.md), [v0.5.1 release notes](RELEASE_v0_5_1.md) and [validation summary](../reports/validation_summary.json) |
| Reproduce the local checks | [Contributor guide](../CONTRIBUTING.md) |
| Assess scale and deployment evidence | [Workload feasibility](WORKLOAD_FEASIBILITY.md) and [mainnet readiness](MAINNET_READINESS.md) |

## Science and molecular inputs

| Document | What it covers |
| --- | --- |
| [ORVIA-001 protocol](PROTOCOL_ORVIA_001.md) | Proposed state-specific cardiac-myosin relative binding-free-energy experiment; scientific execution remains blocked |
| [Source audit](SOURCE_AUDIT.md) | Pinned structural sources, provenance and limits of the deposited model |
| [Ligand input decisions](INPUT_DECISIONS_v0_2.md) | Compound identity, atom correspondence and input choices |
| [Receptor preparation](PREPARATION_v0_3.md) | Reproducible receptor selection and retained source coordinates |
| [Scientific readiness](SCIENTIFIC_READINESS.md) | Completed identity work and missing parameterized molecular inputs |
| [Alternative-model audit](../data/prepared_candidate/alternative_models/README.md) | Public cofactor-model provenance and compatibility checks |
| [ADP/phosphate proposal](PROPOSED_ADPPI_PROTOCOL_v0_1.md) | Unapproved alternative protocol; does not replace the selected ORVIA-001 state |

## Engine reference

The paths below are development components and alternative coordinators. Their presence in the same repository does not mean they form one validated production engine.

| Area | Guides |
| --- | --- |
| Numerical foundation | [Binary128 arithmetic](NUMERICS.md) · [Angles and torsions](ANGULAR.md) · [Stochastic numerics](STOCHASTIC_NUMERICS.md) |
| Pair interactions | [Direct nonbonded](NONBONDED.md) · [Switched nonbonded](SWITCHED_NONBONDED.md) · [Periodic geometry](PERIODIC_GEOMETRY.md) · [Ewald electrostatics](EWALD.md) |
| Data and state | [Paged inputs](PAGED_DATA.md) · [Dynamics inputs](DYNAMICS_DATA.md) · [Periodic inputs](PERIODIC_DATA.md) · [Working state](WORKING_STATE.md) |
| Execution foundations | [Harmonic execution](EXECUTION.md) · [Paged execution](PAGED_EXECUTION.md) · [Finite-system dynamics](DYNAMICS_EXECUTION.md) · [Velocity-Verlet numerics](DYNAMICS_NUMERICS.md) |
| Periodic dynamics | [Periodic execution](PERIODIC_EXECUTION.md) · [Independent periodic reference](PERIODIC_NUMERICS.md) · [Neighbor lists](NEIGHBOR_LIST.md) |
| Sampling and relaxation | [Langevin dynamics](LANGEVIN_EXECUTION.md) · [Constraint primitives](CONSTRAINTS.md) · [Constrained dynamics](CONSTRAINED_DYNAMICS.md) · [Minimization](MINIMIZATION.md) |
| Alchemical math and analysis | [Alchemical/MC primitives](ALCHEMICAL_AND_MC.md) · [Free-energy analysis](FREE_ENERGY_ANALYSIS.md) · [Time-series diagnostics](TIMESERIES_DIAGNOSTICS.md) |

## Evidence, scale and release

| Document | What it establishes |
| --- | --- |
| [Evidence guide](../reports/README.md) | How to navigate the reports, validation records and their scope |
| [Validation summary](../reports/validation_summary.json) | Recorded full-suite results and the source/evidence inventory they bind |
| [Compute costs](COMPUTE_COST.md) | Inline pair arithmetic and its separate microbenchmark and small-trajectory measurements |
| [Workload feasibility](WORKLOAD_FEASIBILITY.md) | Measured local pair work and the limits of extrapolating it to a complete campaign |
| [Local state-fork smoke](FORK_SMOKE.md) | Two-kernel local check using Ethereum Shanghai rules |
| [Target-node probe](TARGET_NODE_EXECUTION.md) | Dated, read-only numerical checks through a Robinhood provider; no transaction broadcast |
| [Mainnet readiness](MAINNET_READINESS.md) | Release gate, deployment rehearsal and unresolved target-chain requirements |
| [Production gaps](PRODUCTION_GAPS.md) | Acceptance work still required for a complete scientific production path |

For exact contract-to-role associations, use the [contract manifest](../data/contract_manifest.json). For changes over time, use the [research log](../RESEARCH_LOG.md); older evidence retains its original scope.
