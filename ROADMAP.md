# ORVIA roadmap

This roadmap describes evidence required for progress. It does not promise deployment dates or scientific outcomes. All 64 intended production instances remain planned.

| Milestone | Current position | Evidence required to complete |
|---|---|---|
| Recover and publish the research | Source recovered and published; v0.5.1 complete local validation passed | Public source and methods, reproducible checks, release identity, archive checksums and research log |
| Validate numerical building blocks | Finite fixtures for forces, dynamics, constraints, Ewald, thermostat, MBAR and diagnostics | Current source-bound suite and explicit numerical domains; independent reference comparisons |
| Reduce execution cost | Inline pair option passes 11 targeted neighbor tests; identical four-atom trajectory uses 1.92% less advancement gas | Complete source-bound acceptance; measured full-model work and cost, with scheduling/state/identity guarantees retained |
| Prepare ORVIA-001 | Heavy-atom source/mapping candidates exist; complete preparation unresolved | Reviewed missing structure, cofactor chemistry, all parameters, hydrogen-complete endpoints/hybrid topology, two solvated legs and pinned model hashes |
| Connect one production scientific path | Alternative component coordinators exist | One identity-bound Hamiltonian and complete minimization/equilibration/sampling/cross-state-energy/analysis pipeline |
| Validate the full experiment | No full-system binding result | Independent full-system force/ensemble reference; convergence, overlap, decorrelation, repeat uncertainty and declared acceptance criteria |
| Prove target feasibility | Read-only RPC, local state-fork smoke and actual target-provider two-kernel read-only checks available | Robinhood execution-client rehearsal, full-model phase gas/bytes, measured allocation and accepted total duration/fee budget |
| Release to mainnet | Release gate closed; no production deployment | Completed source-bound evidence, independent review, all useful production roles, source verification and reviewed public deployment plan |

Direct resumable transactions come first. Swap/pool triggers are deferred. Deploying more addresses does not remove computational work or prove scientific validity.

See [production gaps](docs/PRODUCTION_GAPS.md) for detailed acceptance and [the research log](RESEARCH_LOG.md) for dated evidence.
