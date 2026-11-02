# ORVIA v0.5.1 development checkpoint

2 November 2026. Mainnet readiness remains false. This checkpoint continues the recovered v0.5.0 research package; it does not produce a cardiac-myosin binding result or deploy production contracts.

## Changes

- **Pair execution:** the bounded neighbor NVE coordinator can select the exact pinned inline pair runtime. Admission also checks compatible pinned arithmetic; module identities, force ordering and state/commit barriers remain bound. New tests compare the original and inline paths at complete trajectory checkpoints and exercise interruption, partitioning, rollback and rejected identities. The targeted suite passed 11 tests. Identical four-atom, three-step advancement used 66,727,850 gas through the original kernel and 65,446,162 gas through the inline kernel, a 1.92% saving, excluding deployment, inputs and registration. The separate 51–53% figure is a pair-only microbenchmark. [Method and evidence](COMPUTE_COST.md).
- **Scientific input audit:** the public alternative model now checks every positional atom/residue identity in the topology prefix and the selected cofactor charge convention. Five Mg/acetate identity mismatches prevent simple PDB truncation. CHAMBER decoding recovers the reference model's H2PO4−, Mg2+ and ADP3− sums; these are not transferred cardiac parameters. Adversarial self-checks reject the wrong scaling factor, selected-atom mismatch and source-byte tampering. [Audit](../data/prepared_candidate/alternative_models/README.md).
- **Candidate protocol:** a separately named, versioned ADP/phosphate preparation proposal records source hashes and unresolved scientific choices. It remains unapproved, unregistered and unready for execution. The original vanadate-containing ORVIA-001 model and its blocked registration gate are unchanged. [Proposal](PROPOSED_ADPPI_PROTOCOL_v0_1.md).
- **Target-chain evidence:** read-only Robinhood mainnet access succeeds through a documented provider. A source- and block-pinned local state-fork smoke exercises two numerical kernels under Ganache's Ethereum Shanghai rules. It does not validate Robinhood Nitro execution, a full prepared system, sustained throughput or production fees. [Scope](FORK_SMOKE.md).
- **Research publication:** the recovered source now has persistent status, roadmap and research-log documents. The archived baseline and current-version validation identities remain distinct.

## Validation identity

The recovered v0.5.0 archive recorded 205 passing Node/EVM tests and 63 passing Python references. Those historical counts are not a v0.5.1 result. The current checkpoint's complete run status, exact source bindings, counts and logs are authoritative only in [validation_summary.json](../reports/validation_summary.json). An incomplete or failed report is not a passing release; a passing component suite does not clear the scientific/mainnet gate.

## Remaining release requirements

Complete the reviewed cardiac protein/ligand/cofactor/solvent inputs, hydrogen-complete alchemical topology and compatible full Hamiltonian. Connect one full-scale minimization, equilibration, sampling and correlation-aware analysis path. Validate the prepared system and its ensemble independently, demonstrate sufficient sampling and uncertainty diagnostics, measure complete target-system gas/storage/time/fees, and finish target execution/source-verification and independent security review.

The design still has 64 planned production instances, with no Robinhood production deployment. Direct resumable calls precede swap/pool triggers. A local kernel test, additional contract addresses or an alternative chemical-state proposal cannot satisfy the missing full experiment. See [production gaps](PRODUCTION_GAPS.md) and [mainnet readiness](MAINNET_READINESS.md).
