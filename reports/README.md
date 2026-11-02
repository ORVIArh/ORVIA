# Research evidence

Reports record a particular source version, fixture and execution environment. Start with the validation summary; individual results do not establish full-system readiness.

| Looking for | Start here | Scope |
|---|---|---|
| Complete checkpoint validation | [Validation summary](validation_summary.json) | v0.5.1: 212 Node/EVM tests, 63 Python references and nine check groups |
| Compiler and deployment evidence | [Compiled sizes](compiled_sizes.json) · [Local rehearsal](deployment_rehearsal.json) | Source/runtime checks and local development execution |
| Execution costs | [Neighbor gas](neighbor_execution_gas.json) · [Inline pair gas](inline_nonbonded_gas.json) · [Workload study](workload_feasibility.json) | Declared fixtures and illustrative workload assumptions; not a complete mainnet campaign quote |
| Network observations | [Mainnet preflight](mainnet_preflight.json) · [Local fork smoke](target_fork_smoke.json) · [Target-node probe](target-execution-probe.json) | Dated read-only observations and limited numerical-kernel checks |
| Release readiness | [Readiness report](mainnet_readiness.json) · [Remaining requirements](../docs/PRODUCTION_GAPS.md) | Mainnet readiness remains false |
| Archived package identity | [Package checksums](package_checksums.json) | Hashes from the original v0.5.1 source-and-validation archive, not a manifest of this subsequently edited Git tree |

## Reading the records

The [validation summary](validation_summary.json) binds its input inventory, compiler outputs, generated evidence and nine check logs. The adjacent `*_validation.json`, `*_reference.json` and `*_execution_gas.json` files provide component detail. Follow the summary's exact log paths when inspecting the completed run.

Earlier review notes, targeted runs and incomplete attempts are retained for traceability. Their presence does not override the completed summary or imply acceptance. In particular, `ewald_dynamics_isolated_incomplete.log` records an incomplete attempt.

Local fixture agreement does not validate a prepared cardiac-myosin calculation, sufficient sampling, a binding-free-energy result or production deployment. Read [status](../STATUS.md), [release notes](../docs/RELEASE_v0_5_1.md) and [the research log](../RESEARCH_LOG.md) alongside the evidence.

[Documentation index](../docs/README.md) · [Repository](../README.md)
