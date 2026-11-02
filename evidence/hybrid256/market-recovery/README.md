# Market-fee deployment recovery evidence

This packet preserves the reviewed software and local tests used to continue the same 256-contract reporting-infrastructure plan on Robinhood Chain mainnet 4663. The unchanged plan is `814e9c0aced4f8c6ef24bf4ca7fe5d423ef8bb4e4d54216a3dea02484958b50c`: one coordinator and 255 shards in 33 successful deployment transactions. Mainnet receipts and runtime verification are separate evidence; a local test pass is not proof of deployment or molecular correctness.

The operator permits one explicitly reviewed nonce 3 price replacement. Chain, sender, nonce, target, calldata, zero value and gas limit stay fixed. Both signed versions are saved privately before replacement submission; a canonical successful receipt selects the winner before later calls. New signatures use a fresh market quote/base fee plus 25% inclusion margin, with no cap tied to the historical quote. Live balance, gas, exact intent, source/runtime identity and sender-lock checks remain enforced. There is no iterative automatic rebid.

No private deployment journal, replacement history, raw transaction signature, wallet, password or RPC credential is included. Files named `reviewed-*` are the frozen pre-deployment review records; their zero-public-transaction statements describe those checks. This historical first-use recovery gate expected four saved entries. It is not an instruction to rerun a completed deployment.

## Files

- `market-tests-18.log`: five market-policy tests and 13 independent recovery-race tests, rerun locally with public synthetic keys and mocked RPC.
- `reviewed-helper-tests-13.log`, `reviewed-operator-tests-13.log`, `reviewed-bridge-tests-12.log`: exact independent review logs retained in the frozen release.
- `reviewed-freeze.json`: release, launcher, bridge and runtime-source hashes selected before the live continuation.
- `frozen-release-manifest.json`, `frozen-launcher.command.txt`, `frozen-policy.md`: exact public release bindings and policy. The launcher is stored as text for historical inspection.
- `source-snapshot.tar.gz`, `source-hashes.json`: source, test, dependency and CI snapshot with every archived file hashed. No Node binary or installed package tree is included.
- `dependency-inventory.json`: required new/existing repository files and pinned npm versions.
- `package-review.json`, `CHECKSUMS.sha256`: member/hash verification and checksums for this packet.

The full unchanged plan already exists in the repository's [original release archive](../deployment-release.tar.gz), member `ORVIA-Hybrid256-Release/plan.json`, SHA-256 `8bb11bc8724d604ae71132f3628820d7327540ba95cac7a50f911245b06f4341`. It is not duplicated here.

## Reproduce the local policy and race tests

From a clean repository checkout with Node 24.22.1:

```sh
npm ci --ignore-scripts
node --test scripts/deployment/test_hybrid_market_policy.mjs scripts/deployment/test_market_recovery_review.mjs
```

These 18 tests do not open a production wallet, contact a public RPC or send transactions. The existing `npm run test:hybrid` glob already includes the five policy tests. The updated hybrid workflow adds the 13 recovery-race tests explicitly. This packet does not claim the full repository suite or scientific validation passed.
