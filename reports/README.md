# Research evidence

Reports record a particular source version, fixture and execution environment. The current v0.6.0-dev [validation summary](validation_summary.json) is deliberately incomplete. Targeted passes below do not establish complete-suite, full-model or mainnet readiness.

| Looking for | Start here | Scope |
|---|---|---|
| Current complete-suite status | [Validation summary](validation_summary.json) | `development_in_progress`, `passed: false`; historical passes do not validate changed source |
| Local 256-contract prototype | [Connected validation](complete_256_validation.json) · [Portable packaging](complete_256_packaging.json) · [Guide](../docs/COMPLETE_256_PROTOTYPE.md) | 32 core contracts plus 224 banks; constrained step/sample and one two-state analysis; raw C4 remains standalone |
| Exact creation/runtime inputs | [256-address inventory](../evidence/256-contract-creation/deployment-runtime-input.json) | Source-bound local creation bytes/runtime/gas; captured before long integration, so its pending status is intentional |
| Historical v0.5.1 checkpoint | [Archived overview](../docs/DEVELOPMENT_CHECKPOINT.md) · [Release notes](../docs/RELEASE_v0_5_1.md) | 212 Node/EVM tests, 63 Python references and nine groups at that dated checkpoint |
| Compiler and deployment evidence | [Compiled sizes](compiled_sizes.json) · [Local rehearsal](deployment_rehearsal.json) | Source/runtime checks and local development execution |
| Execution costs | [Neighbor gas](neighbor_execution_gas.json) · [Inline pair gas](inline_nonbonded_gas.json) · [Workload study](workload_feasibility.json) | Declared fixtures and illustrative workload assumptions; not a complete mainnet campaign quote |
| Large-coordinator creation | [Target-provider report](target_256_creation_probe.json) · [Scope](../docs/TARGET_256_CREATION_PROBE.md) | Read-only target calls returned both exact coordinator runtimes; no mainnet deployment |
| Network observations | [Mainnet preflight](mainnet_preflight.json) · [Local fork smoke](target_fork_smoke.json) · [Target-node probe](target-execution-probe.json) | Dated read-only observations and limited numerical-kernel checks |
| Release readiness | [Readiness report](mainnet_readiness.json) · [Remaining requirements](../docs/PRODUCTION_GAPS.md) | Mainnet readiness remains false |
| Archived package identity | [Package checksums](package_checksums.json) | Hashes from the original v0.5.1 source-and-validation archive, not a manifest of this subsequently edited Git tree |

## Reading the records

A completed full-suite summary binds its input inventory, compiler outputs, generated evidence and nine check logs. The current summary does not claim that completed state. The adjacent `*_validation.json`, `*_reference.json` and `*_execution_gas.json` files provide component detail. Follow the summary's exact log paths when inspecting the completed run.

Earlier review notes, targeted runs and incomplete attempts are retained for traceability. Their presence does not override the current incomplete summary or imply acceptance. The 256-contract fixture preregistered three paired repeats, then completed one campaign’s two-state analysis; it did not finish all repeat pairs or their uncertainty aggregation. Its raw C4 known case is not an integrated alchemical C4 model. In particular, `ewald_dynamics_isolated_incomplete.log` records an incomplete attempt.

Local fixture agreement does not validate a prepared cardiac-myosin calculation, sufficient sampling, a binding-free-energy result or production deployment. Read [status](../STATUS.md), [the current architecture](../docs/ARCHITECTURE_256.md) and [the research log](../RESEARCH_LOG.md) alongside the evidence.

[Documentation index](../docs/README.md) · [Repository](../README.md)
