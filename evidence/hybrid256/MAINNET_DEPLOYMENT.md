# 256-contract mainnet deployment

ORVIA's GPU reporting infrastructure is deployed on **Robinhood mainnet, chain 4663**. All **33 transactions succeeded**, creating **one coordinator and 255 report shards: exactly 256 contracts**. No public testnet was used.

| Item | Confirmed result |
|---|---|
| Coordinator | `0x3B188B4c5B76b009d80455D3bbB7597983E390f0` |
| Owner and report operator | `0x2541a9e93B5C853E9208b0C5C7386dD458424c77` |
| Total contracts | 256 |
| Successful transactions | 33 |
| Actual total gas used | 229,756,618 |
| Actual total infrastructure fee | **0.004612876889674 ETH** |
| First / last transaction block | 104367144 / 104387978 |
| Deployment runner verification completed | 2026-11-02 17:23:14 UTC |
| Frozen plan SHA-256 | `814e9c0aced4f8c6ef24bf4ca7fe5d423ef8bb4e4d54216a3dea02484958b50c` |

The actual fee is the sum of `gasUsed × effectiveGasPrice` across the 33 successful canonical receipts. It covers the complete contract deployment and shard provisioning. Future experiment registration, report submissions and GPU campaigns are additional; this is not a total scientific campaign price.

## Verification

[The public verification report](mainnet-market-verification.json) records all 256 addresses and expected runtime hashes, all 33 transaction hashes and receipts, the observation block, and the exact fee calculation. The read-only verifier checked every deployed runtime, every shard registration and registered code hash, the owner/operator, successful canonical receipts, and confirmation depth. It verified that only one transaction won nonce 3.

The initial fourth transaction did not confirm at its original fee. A reviewed recovery signed one replacement with the same chain, sender, nonce, target, calldata, value and gas limit; only gas price changed. The confirmed replacement is `0x1d5c7a461cc7fbedfb3ea14c5e6436bffcd91dbcc294f1dcf5031ea85d451098`. Subsequent transactions used current market fees plus a 25% inclusion margin, without the historical quote-based fee cap. The superseded transaction incurred no mined transaction fee. Private signed journals and wallet secrets are not published.

[Recovery source and tests](../../scripts/deployment/) · [Recovery review evidence](market-recovery/README.md) · [Contract architecture](../../contracts/hybrid/README.md)

## What this deployment establishes

The contracts can register declared experiments and runs and retain operator-signed checkpoint/result commitments. GPU hardware performs the molecular calculations. EIP-712 signatures authenticate the operator and report contents; they do not prove numerical or scientific correctness. Full artifacts must remain retrievable separately.

No accepted scientific result was submitted by this deployment. The separately named phosphate experiment has passing full-model numerical diagnostics, but parameter/method acceptance, full alchemical endpoints, production integration and sampling remain separate gates. Owner/operator addresses are immutable; this release has per-run cancellation but no global pause, key rotation or upgrade mechanism.
