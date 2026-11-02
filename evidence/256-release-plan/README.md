# Mainnet-only public draft and address-state evidence

The unsigned draft uses the authorized public sender `0x2541a9e93B5C853E9208b0C5C7386dD458424c77`, nonce 0, and Robinhood mainnet 4663. It proposes32 core contracts and224 fixed banks, with91 infrastructure transactions. Protocol and full molecular input commitments remain explicitly unresolved. The draft is `prepared-but-blocked`, not a deployment authorization or scientifically accepted production plan.

`mainnet-state-check.json` records a successful read-only scan through the user's configured provider, identified only as `robinhood-mainnet.g.alchemy.com`. All 256 planned addresses had empty code and zero nonce at block `0x6363e99`, hash `0xc88129085fe3320ba3d3bd501dbff2c54925643707ed6a063dccb8ad60d1a0e2`. All 512 code/nonce queries were fetched at that block with bounded-four concurrency and consumed exactly once by the unchanged canonical checker. Sender nonce and the final block/late pending nonce were checked through fresh requests. The report binds the exact public plan hash.

The same run obtained an actual pending-state estimate for **only the first FloatMath creation**: **1,254,228 gas**, with an observed gas price of **20,026,000 wei**. It used exact planned initcode and no state override. No dependent contract was deployed, so no dependent-stage or complete-deployment/model/campaign gas or fee quote is claimed. The estimate is a dated observation and must be refreshed before any future signing.

There were526 read-only requests and zero submitted transactions. No key, wallet password or signing account was loaded. The provider URL/key remains in a protected local file outside Git and is absent from the report, plan and retained sources. Remote error messages are redacted. `manifest.json` binds every packaged file and records a final recheck of all compiled source/package/architecture hashes against the frozen plan.

`attempts.json` preserves three earlier incomplete attempts: a stopped Pinax sequential scan, a Pinax prefetch stopped by HTTP429, and an official public-RPC scan stopped when the user authorized Alchemy. Their original sources and pending reports are retained under `sources/` and `attempts/`; none is relabeled as a pass. The separate official-endpoint check returned chain 4663 through the exact public URL listed in [Robinhood's connection guide](https://docs.robinhood.com/chain/connecting/). No testnet endpoint was queried.

To repeat the final scan after this folder is installed as `evidence/256-release-plan/`, run:

```sh
node evidence/256-release-plan/recheck.mjs /tmp/orvia-mainnet-state-fresh
```

The output directory must not exist. The replay reads the provider URL only from `~/.orvia/rpc/robinhood-mainnet-alchemy.url`, requires a regular file with 0600 permissions, HTTPS and the expected provider hostname, and rejects a chain other than 4663. The original executed source is retained unchanged; replay adaptation changes only imports/root/output paths and resolves the same credential-file location through the current user's home directory. No network replay was performed merely to package these files.

This check proves neither deployed runtime/storage initialization nor full-model correctness, throughput, funding or fee acceptance. No target contract was created and no molecular input was uploaded. The complete current-source suite, C4/alchemical/model choices, full physical validation and production readiness remain separate gates.
