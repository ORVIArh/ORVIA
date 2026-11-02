# ORVIA mainnet-lite result anchor

This is a proposed low-cost publication option for operator-attested artifact hashes. Molecular work would run off-chain, with GPU acceleration where supported; no accepted complete GPU molecular run has been produced for this candidate. The operator signs hashes for the inputs, method, settings, and output; the contract checks that signature and records the hashes in an event. The illustration below does not guarantee an all-in $200 budget.

This does **not** prove that the molecular calculation was correct or run as reported. It changes the trust model from on-chain execution to an operator-attested GPU result. The full on-chain engine remains a separate research implementation and is not made mainnet-ready by this contract.

## Measured budget

`measure_budget.mjs` compiles with Solidity 0.8.26, optimizer 200, and Shanghai EVM settings; deploys and submits one signed report on a local EVM; then performs a read-only creation-gas estimate against Robinhood Chain (4663).

The latest `budget-measurement.json` records:

- Robinhood Chain creation estimate for this bytecode.
- Local-EVM gas for one successful signed report.
- An illustrative USD conversion using a dated assumed ETH price and an observed chain gas-price quote.
- 100 and 200 gwei stress scenarios.

The target creation estimate is read-only and may already include the target's L1 data allocation. The anchor transaction uses local-EVM gas, so its target execution and L1 data allocation are unmeasured. Adding those two gas values is a mixed illustration, not a complete target fee quote. The ETH/USD value of 2,281.33 is a dated illustrative assumption, with no claim of live market provenance. Wallet/relayer charges and future fee/price movements are also outside the illustration. Obtain exact target estimates for both transactions before assessing a spending cap. No mainnet transaction was sent.

## Data and trust boundary

Store the complete trajectory, scientific report, and exact input artifacts outside the contract. Hash a canonical encoding of each artifact and include its hash in the signed report. Keep the artifacts available from durable storage and publish a content-addressed copy. A wallet controlling the immutable operator key can attest to any hashes, so independent replication or a future proof verifier is needed for stronger scientific assurance.
