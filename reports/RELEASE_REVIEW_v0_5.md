# ORVIA v0.5 release packaging and reproducibility review

Scope: source-level review of the check runner, package builder, current-count manifest, tests/oracles, release gate and generated-evidence handling. This is a development-release integrity review, not an independent security audit, scientific acceptance or mainnet approval.

**Status at review handoff:** packaging/integrity fixes are source-frozen and their focused tests pass. The root agent has started the authoritative complete check. This document does not assert that the full check has passed. Only a completed, current, integrity-verified `reports/validation_summary.json` establishes the local suite outcome.

## Concrete defects found and resolved

| Finding | Severity | Resolution |
|---|---|---|
| Same-version stale success could survive an interrupted check | High | The runner now atomically writes schema-version 2 `in_progress`, `passed:false` before check discovery, compilation or subprocess work. It writes failure/incomplete state on errors. Packaging/readiness reject legacy, interrupted and incomplete reports. |
| A passing report was bound only to version and a partial Solidity source list | High | Exact static input file sets and SHA-256 bytes are recorded before execution and checked again before acceptance. Added, missing or changed source/test/reference/script/model inputs invalidate the result. The compiled Solidity set must exactly match the validated source inventory. |
| Recompilation or changed logs could detach tests from packaged artifacts | High | Compiler report, build artifacts and all nine ordered group logs are hash-bound. Package and readiness use the same verifier. Every required group must be present once, in order, passed, and exit with status zero. |
| Numerical/deployment report JSON could be altered after passing tests | Medium | The 36 explicitly generated numerical/deployment JSON artifacts are cleared before checks, must be regenerated, and are individually hash-bound. A missing or altered generated report prevents package acceptance. |
| A test-only injected-command hook could create a real-looking success | Medium | The hook was removed. `runChecks` accepts only its root option and fixed built-in commands. Injected command arrays are rejected before work. Mutation tests construct clearly labeled synthetic metadata only inside temporary directories. |
| Package collection had a time-of-check/time-of-use gap | Medium | The verifier returns the exact accepted summary-file hash. Packaging checks the captured archive payload's summary, exact static-input set, compiler artifacts, evidence and log bytes against that summary before writing the ZIP. Omitted bound symlinks and concurrent changes cannot silently enter as validated payloads. |
| Including operational acceptance records created a validation-hash cycle | Medium | Operational acceptance/operator/slot-evidence files and the data/production evidence directory are explicitly excluded from test-input identity and remain independently bound by the production readiness gate. Scientific/model input data remain included. |

The deployment-lane reviewer independently inspected the final fixes, including fixed commands, generated-evidence paths, captured-payload comparisons and readiness wiring, and reported no remaining blocking defect in this review scope. This is peer engineering review, not an independent organizational audit.

## Exact identity boundary

The static inventory includes every regular file under `contracts/`, `test/`, `reference/`, `scripts/` and `data/`, plus `package.json`, `package-lock.json` and `requirements-research.txt`. Python caches are excluded. Input symlinks are rejected. This captures the actual scientific fixtures, oracle programs, input audits, manifest, tests and build/check code; it is more than a list of Solidity files.

The operational exceptions are exactly:

```text
data/production_acceptance.json
data/operator_deployment.json
data/production_slot_evidence.json
data/production/  (evidence directory)
```

The production-evidence loader separately constrains allowed locations, verifies descriptor hashes and checks release/model/protocol bindings. Excluding those records from test-input identity avoids requiring a cryptographic fixed point when they refer to the validation digest. It does not make those records trusted scientific evidence by declaration.

Generated compiler outputs are `reports/compiled_sizes.json` and `build/artifacts.json`. The fixed generated-evidence list resides in `scripts/validation_inventory.mjs` and currently contains 36 JSON files produced by the checked tests/rehearsal. Every actual group log is separately bound. The summary does not hash itself recursively; packaging pins the accepted summary's byte hash externally during collection.

Docs, release notes, review Markdown, readiness/preflight outputs, targeted logs and package checksum metadata are outside test-input identity. They can be updated after a successful suite without rerunning EVM work. They must not be presented as freshly tested scientific outputs merely because they are included in the archive. Actual test inputs and the declared generated-evidence set cannot change without invalidating acceptance.

## Focused validation completed

`test/release-packaging.test.mjs` passed all three tests, zero failures, in approximately 3.1 seconds. These checks use temporary synthetic directories and do not recursively execute the real scientific suite.

Coverage includes altered/new/missing code, tests, fixtures, scripts and model data; changed dependency pins; changed compiler artifacts, numerical/deployment reports and group logs; missing groups, failed groups, legacy/in-progress summaries; same-version subprocess failure and SIGKILL interruption; rejected command injection; changed inputs during a nominally successful fixed-command sequence; and allowed operational evidence/docs additions. A successful package is exercised for the synthetic baseline and rejected for the mutations. Package checksums still verify the resulting archive payloads.

JavaScript syntax checks passed for the check runner, shared verifier and deploy CLI; Python compilation passed for the package script. A read-only invocation of the real readiness CLI rejected the stale prior-version report and missing current evidence as expected. This is rejection-path evidence, not a production-ready result.

## Counts, oracle scope and pending authoritative check

The inspected manifest is architecture version 0.5.0 with **44 deployable experimental product types** and **64 planned production instances**, all `planned`. The compiled inventory excludes test harnesses, zero-runtime interfaces/abstract contracts and the internal ABDK library. Four experimental coordinator/minimizer runtimes exceed 24,576 bytes; their test relaxation and distinct target planning limit remain disclosed. The retained periodic deployment rehearsal has 16 core plus seven populated input-page instances (23 local instances), which is a fixture count and must not be added to or confused with the 64 intended production slots.

The current fixed runner discovers 26 Node test files and nine Python test files. Its nine groups remain:

1. Compilation.
2. Local EVM components, integration paths, deployment rehearsal and release-integrity tests.
3. Independent Python reference tests.
4. Architecture manifest and mutation checks.
5. Structural input audit.
6. Ligand-pair identity and chemistry audit.
7. Preparation audit and self-tests.
8. Scientific-readiness audit and self-tests.
9. Packaged alternative-model provenance audit and self-tests.

Python research dependencies and Solidity/npm versions remain pinned; the runner preserves `ORVIA_RESEARCH_PYTHON` selection and streams each group into its own log. The existing independent references use high-precision scalar differentiation, root/constraint solutions, direct covariance sums and declared fixture calculations. They validate their stated finite components, not the physical completeness, equilibrium sampling or clinical interpretation of a cardiac-myosin calculation. Repeat SEM is not MBAR covariance, and finite Ewald reference agreement is not converged electrostatic accuracy.

README, STATUS, architecture and readiness documents distinguish alternative component paths from a complete production sampler. The production acceptance gate additionally requires evidence for the whole prepared model and measured workload. Current planned slots, scientific gaps and absent live target evidence keep that gate closed. No new broad scientific test requirement was introduced by this packaging review.

## Reviewed source identities

These are SHA-256 hashes of the final reviewed file bytes, not EVM runtime Keccak hashes. This table is a handoff snapshot; the authoritative validation report will independently bind its actual input inventory and generated artifacts.

| File | SHA-256 |
|---|---|
| `scripts/check.mjs` | `ec4bfd006eb2b9fc669ba7350a35578bfc932ae6296baf456e94baa42712a6a8` |
| `scripts/validation_inventory.mjs` | `dc890a021324927ceef1d476756f7ef5857c9f6143ec403b3f8b3a3a2d54cf00` |
| `scripts/package.py` | `f1e4325f36654f53edeec12a3110e041f9ddd40688fadb3ccb320f833fd496bd` |
| `scripts/deploy.mjs` | `487c7a310a585f4f7828029751053e50ac379ff4206c84df8df2baa85fafc683` |
| `test/release-packaging.test.mjs` | `775d6fe8247df1741c2a39f88e3390653ab636879a1158937dddb805f3f92a09` |
| `scripts/compile.mjs` | `42993413a11ef99d61a624b097ddf19aa4d74d1bbae7e3f599deb309a03c2146` |
| `scripts/validate_manifest.py` | `34af20f287ee932a1ccad1a34184088f105d55e4892a509b7404718b8139be1e` |
| `scripts/deployment/release.mjs` | `0e1582628bd3b4a0b35dc9e81210c4fc474234512c62d50c524cdae997ca5799` |
| `test/deployment.test.mjs` | `062d7db2396699625692163837c9fa17592f3cd216924c5345de34276fff73c0` |
| `package.json` | `e9b56b08011ef73cf97c77159b886fd7cd85d4d770f30295d84aacc37362555f` |
| `package-lock.json` | `cdc4d3856db1a7205157f0fb801628c80522d52af2954bca45542d721b3b6767` |
| `requirements-research.txt` | `967f50668cea7302044e642089e69f93f781a18a0af8ba914017e6bebbb09eea` |
| `data/contract_manifest.json` | `c603c26f81334cafb62c54db83d04c2818d38b0203277e3070061a6a3180f63c` |

## Authoritative run completed after this review

The complete source-pinned validation run finished at `2026-11-01T20:38:21.755Z`: **205 Node/EVM tests, 63 independent Python reference tests and all nine check groups passed**, with zero failed, cancelled or skipped Node tests. The verifier binds 154 input files, the compiler artifacts, nine logs and 36 regenerated numerical/deployment reports. The separate mainnet gate remains false.

The root run also verified the exact inventory successfully, regenerated `mainnet_readiness.json` with `readyForMainnet: false`, and confirmed the strict production manifest validator rejects the unfinished release. These results supersede the earlier pending-run status; they do not change the review scope or confer production acceptance.
