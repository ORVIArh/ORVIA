# Documentation

ORVIA explores reproducible molecular computation on Robinhood Chain. Start with the research question, inspect the implementation, then follow the evidence.

**Current snapshot: v0.6.0-dev.** The actual local 256-contract prototype has targeted integration evidence. The complete current-source suite remains incomplete, scientific acceptance remains open, and mainnet readiness is false. No ORVIA production contract has been deployed to Robinhood.

[Project home](../README.md) · [Current status](../STATUS.md) · [Roadmap](../ROADMAP.md) · [Research log](../RESEARCH_LOG.md) · [Contributing](../CONTRIBUTING.md)

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the project and its boundaries | [Active 256-contract architecture](ARCHITECTURE_256.md) and [production gaps](PRODUCTION_GAPS.md) |
| Understand the proposed experiment | [ORVIA-001 protocol](PROTOCOL_ORVIA_001.md) and [scientific readiness](SCIENTIFIC_READINESS.md) |
| Review the current implementation | [Actual local 256-contract prototype](COMPLETE_256_PROTOTYPE.md), [connected pipeline](MOLECULAR_PIPELINE.md) and [evidence guide](../reports/README.md) |
| Review the historical v0.5.1 checkpoint | [Archived overview](DEVELOPMENT_CHECKPOINT.md) and [v0.5.1 release notes](RELEASE_v0_5_1.md); these do not validate current source |
| Reproduce the local checks | [Contributor guide](../CONTRIBUTING.md) |
| Assess scale and deployment evidence | [Workload feasibility](WORKLOAD_FEASIBILITY.md) and [mainnet readiness](MAINNET_READINESS.md) |

## Science and molecular inputs

| Document | What it covers |
| --- | --- |
| [ORVIA-001 protocol](PROTOCOL_ORVIA_001.md) | Proposed state-specific cardiac-myosin relative binding-free-energy experiment; scientific execution remains blocked |
| [Source audit](SOURCE_AUDIT.md) | Pinned structural sources, provenance and limits of the deposited model |
| [Ligand input decisions](INPUT_DECISIONS_v0_2.md) | Compound identity, atom correspondence and input choices |
| [Receptor preparation](PREPARATION_v0_3.md) | Reproducible receptor selection and retained source coordinates |
| [Scientific readiness](SCIENTIFIC_READINESS.md) | Identity, parameter/preparation and physical acceptance gates |
| [Ligand preparation](LIGAND_PREPARATION_v0_1.md) | Native preparation environment, endpoint parameter candidates and independent energy/force checks |
| [Full hybrid inputs](FULL_HYBRID_INPUTS.md) | Complete complex/solvent candidate streams and their remaining scientific gates |
| [Alternative-model audit](../data/prepared_candidate/alternative_models/README.md) | Public cofactor-model provenance and compatibility checks |
| [ADP/phosphate proposal](PROPOSED_ADPPI_PROTOCOL_v0_1.md) | Unapproved alternative protocol; does not replace the selected ORVIA-001 state |

## Engine reference

The connected prototype and alternative coordinators retain separate evidence scopes. Connected small-fixture execution does not establish a validated full molecular production experiment.

| Area | Guides |
| --- | --- |
| Connected prototype | [256-contract fixture](COMPLETE_256_PROTOTYPE.md) · [Molecular pipeline](MOLECULAR_PIPELINE.md) · [Constrained pipeline](CONSTRAINED_MOLECULAR_PIPELINE.md) |
| Numerical foundation | [Binary128 arithmetic](NUMERICS.md) · [Angles and torsions](ANGULAR.md) · [Stochastic numerics](STOCHASTIC_NUMERICS.md) |
| Pair interactions | [Direct nonbonded](NONBONDED.md) · [Switched nonbonded](SWITCHED_NONBONDED.md) · [Periodic geometry](PERIODIC_GEOMETRY.md) · [Ewald electrostatics](EWALD.md) |
| Fixed storage and spatial work | [Banked state](BANKED_WORKING_STATE.md) · [Banked inputs](BANKED_INPUT_STORAGE.md) · [Cell index](PERIODIC_CELL_INDEX.md) · [Ordered pairs](ORDERED_NEIGHBOR_PAIRS.md) · [Spatial Hamiltonian](SPATIAL_HAMILTONIAN.md) |
| Data and state | [Paged inputs](PAGED_DATA.md) · [Dynamics inputs](DYNAMICS_DATA.md) · [Periodic inputs](PERIODIC_DATA.md) · [Working state](WORKING_STATE.md) |
| Execution foundations | [Harmonic execution](EXECUTION.md) · [Paged execution](PAGED_EXECUTION.md) · [Finite-system dynamics](DYNAMICS_EXECUTION.md) · [Velocity-Verlet numerics](DYNAMICS_NUMERICS.md) |
| Periodic dynamics | [Periodic execution](PERIODIC_EXECUTION.md) · [Independent periodic reference](PERIODIC_NUMERICS.md) · [Neighbor lists](NEIGHBOR_LIST.md) |
| Sampling and relaxation | [Langevin dynamics](LANGEVIN_EXECUTION.md) · [Constraint primitives](CONSTRAINTS.md) · [Constrained dynamics](CONSTRAINED_DYNAMICS.md) · [Minimization](MINIMIZATION.md) |
| Candidate pair numerics | [Fixed96 candidate](FIXED96_CANDIDATE.md) · [Raw standalone C4](C4_PAIR_KERNEL.md); C4 alchemical integration remains unaccepted |
| Alchemical math and analysis | [Alchemical/MC primitives](ALCHEMICAL_AND_MC.md) · [Free-energy analysis](FREE_ENERGY_ANALYSIS.md) · [Time-series diagnostics](TIMESERIES_DIAGNOSTICS.md) |

## Evidence, scale and release

| Document | What it establishes |
| --- | --- |
| [Evidence guide](../reports/README.md) | How to navigate the reports, validation records and their scope |
| [Validation summary](../reports/validation_summary.json) | Current full-suite status; explicitly incomplete during integration |
| [256-contract validation](../reports/complete_256_validation.json) | Targeted local connected fixture; distinct from complete-suite and full-model acceptance |
| [Compute costs](COMPUTE_COST.md) | Inline pair arithmetic and its separate microbenchmark and small-trajectory measurements |
| [Workload feasibility](WORKLOAD_FEASIBILITY.md) | Measured local pair work and the limits of extrapolating it to a complete campaign |
| [Local state-fork smoke](FORK_SMOKE.md) | Two-kernel local check using Ethereum Shanghai rules |
| [Large-coordinator creation probe](TARGET_256_CREATION_PROBE.md) | Exact runtime returned through read-only target-provider creation calls; no persistent deployment |
| [Target-node probe](TARGET_NODE_EXECUTION.md) | Dated, read-only numerical checks through a Robinhood provider; no transaction broadcast |
| [Mainnet readiness](MAINNET_READINESS.md) | Release gate, deployment rehearsal and unresolved target-chain requirements |
| [Production gaps](PRODUCTION_GAPS.md) | Acceptance work still required for a complete scientific production path |

For the active inventory, use [architecture_256.json](../data/architecture_256.json). The [legacy contract manifest](../data/contract_manifest.json) retains the earlier 64-slot plan and fail-closed readiness checks. For changes over time, use the [research log](../RESEARCH_LOG.md); older evidence retains its original scope.
