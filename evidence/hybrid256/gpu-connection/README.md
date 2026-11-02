# GPU workflow connected on mainnet

The completed H200 full-model phosphate diagnostic is recorded on the deployed **256-contract ORVIA network**. All three connection transactions succeeded: experiment registration, run creation, and the first operator-signed report. Independent read-only verification completed at 2026-11-02T17:45:35.980Z.

| Item | Confirmed result |
|---|---|
| Network | Robinhood mainnet, chain 4663 |
| Coordinator | `0x3B188B4c5B76b009d80455D3bbB7597983E390f0` |
| Report shard / lane | `0x2c3A4c11b5b416E3850dDB6e486757BAF93218b5` / 142 |
| Run | `0x3b60f0204b50f6099581f18463a5796efab01e23e36744b9dffc76d08ca29c69` |
| Report sequence | 1 |
| Completed comparisons | 6 |
| Diagnostic only | true |
| Scientific acceptance | false |
| Connection gas / transactions | 580,013 / 3 |
| Actual full connection fee | **0.000011668948402 ETH** |
| Actual deployment plus connection | **0.004624545838076 ETH** across 36 transactions |

The six cases compare CPU Reference with CUDA double precision at initial, relaxed and post-short-dynamics coordinates for the 132,935-particle complex and 151,505-particle solvent model. These are six comparison cases, not six dynamics steps. The completed GPU worker was stopped after retrieving its results. This proves the retrospective GPU-artifact-to-chain reporting path; it does not establish continuous GPU operation, a contract-dispatched job, production simulation acceptance or a free-energy result.

| Action | Nonce | Gas used | Actual fee (ETH) | Transaction hash |
|---|---:|---:|---:|---|
| registerExperiment | 33 | 190531 | 0.000003811763186 | `0xbf0b568083f0fd3e0024b58b27d494a18c95401d9bfa39171df9a2ebd28ee4dd` |
| startRun | 34 | 177752 | 0.000003593789936 | `0x6eeca7001961f138aa1dacf32ba7f2437bd9b9e3217113546d2203e188fc5c9a` |
| submitReport | 35 | 211730 | 0.00000426339528 | `0xee696c70ceded53ff1a0ab3c215383b13205dbad2f30e2b236737e3e49244c1b` |

The fee is the sum of each receipt's `gasUsed × effectiveGasPrice`. The cumulative amount includes the independently verified [256-contract deployment](../MAINNET_DEPLOYMENT.md), whose proof hash is bound in this report. It excludes GPU billing and future simulations or reports. No public testnet was used.

[Public verification JSON](mainnet-verification.json) records the canonical transaction blocks, observation block, run state and exact commitments. The verifier checked fresh source/artifact identities, coordinator and run-shard runtimes, the EIP-712 digest and every stored report field, successful canonical transaction inclusion, and confirmation depth. [Verifier source](verify-connection.mjs) is the exact local historical verification script; its local paths require adaptation elsewhere. It permits only read RPC methods and publishes no private signing journal.

- Result commitment: `0xef01459ab92929285cdeb2284df6fcad5d73927fde23e3cd9c0e7c84c8dcf2b5`
- Checkpoint commitment: `0x5c12df660b0649fd1a50e421f4e8e06ac6902fee635d174551bff1c9ae3438cc`
- Attestation digest: `0x5922d4f179dea632e51e6590275f41f846098ee0d3d543c79bfcab148ade678e`
- [Exact retrievable diagnostic artifacts and scope](../NATIVE_FULL_MODEL_DIAGNOSTIC.md)
- [Prepared plan review](prepared-plan-review.json), [local gas measurement](conditional-local-gas.json), [manifest review](manifest-review.json), [local unlock review](bridge-review.json)
- [Workflow implementation](../../../scripts/hybrid/GPU_CONNECTION.md)

The wallet was unlocked locally for these three calls. The signing process exited and its local unlock server was closed afterward. Report signatures authenticate the operator's claim; they are not proofs of GPU computation or scientific correctness.
