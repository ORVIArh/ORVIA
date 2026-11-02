# Reviewed continuation at current network fees

This release continues the same 256-contract plan on chain 4663. The first three transactions already created the coordinator and 16 shards. It may replace only the original saved transaction at nonce 3, preserving chain, sender, nonce, target, calldata, value and gas limit. Both signed versions are retained privately before any replacement submission. A canonical receipt selects the winner before further calls.

New signatures use the freshly observed network gas price/base fee plus a 25% inclusion margin. The one-time replacement uses a 25% increase over the greater of the saved price and current network price. The user explicitly removed the historical fee cap. Live balance, gas, transaction identity, nonce, bytecode and registry checks remain enforced.

One local wallet unlock covers the replacement, if still needed, and the remaining 29 new transactions. This deploys reporting infrastructure and does not certify a molecular result. The private deployment journal and replacement history must never be published.
