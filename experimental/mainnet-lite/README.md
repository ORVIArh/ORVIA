# ORVIA mainnet-lite result anchor

This is a proposed low-cost publication option for operator-attested artifact hashes. Molecular work would run off-chain, with GPU acceleration where supported; no accepted complete GPU molecular run has been produced for this candidate. The operator signs hashes for the inputs, method, settings, and output; the contract checks that signature and records the hashes in an event. The illustration below does not guarantee an all-in $200 budget.

This does **not** prove that the molecular calculation was correct or run as reported. It changes the trust model from on-chain execution to an operator-attested GPU result. The full on-chain engine remains a separate research implementation and is not made mainnet-ready by this contract.

## Focused checks and target rehearsal

From the repository root, with the pinned npm dependencies installed:

```sh
node experimental/mainnet-lite/validate.mjs
node experimental/mainnet-lite/measure_budget.mjs
```

The focused checks exercise signature authorization and every signed field, chain/contract domain separation, malformed signatures, zero inputs, valid permissionless relaying, and exact emitted report fields. Duplicate valid reports are deliberately allowed. Consumers must deduplicate by the EIP-712 report digest, rather than signature bytes or transaction/event count. An event is an attestation, not a new experiment or a scientific acceptance decision.

`measure_budget.mjs` uses Solidity 0.8.26, optimizer 200 and Shanghai settings. It deploys and submits a synthetic report locally, then checks the exact constructor runtime on Robinhood Chain through read-only calls at a recorded block. The report call uses an ephemeral code override at an unused address. A valid signature must succeed and an altered signed output must explicitly revert before the quote can pass. Both creation and report gas estimates come from the target RPC. Under Robinhood's [fee model](https://docs.robinhood.com/chain/gas-and-fees/), these estimates include execution and data-posting allocation. No target deployment or transaction is sent.

The report binds source, script, dependency lock, compiler input, runtime, fixture calldata and block hashes. It is initialized as incomplete before work starts and records failure if any required check fails. Provider responses are trusted; the rehearsal does not prove final transaction admission, long-term availability or scientific correctness.

## $200 network-fee policy

The budget report uses an explicit **$10,000/ETH planning ceiling**, not a live price claim. It caps the combined network fee for deployment and one report at **0.02 ETH**. Each proposed gas limit is 125% of its target estimate and the proposed maximum gas price is twice the observed quote. The product of those limits must fit the combined cap. The USD bound holds only while ETH/USD is at or below the stated ceiling.

The recorded operator, signature and counts are synthetic fixtures. Before producing transactions for a real wallet, bind its public address, nonce, deployment address and the actual report artifacts/signature, then refresh both exact target estimates. These synthetic transactions must not be sent. A failed transaction can consume its gas budget; any retries require a new aggregate budget. Separately charged relayer/wallet services and off-chain compute/storage are outside this network-fee cap.

The immutable operator uses ordinary ECDSA/EIP-712 signatures; ERC-1271 smart-contract wallets are not supported. There is no key rotation, revocation, contract upgrade or funds custody. Changing the publisher requires a new anchor address and a corresponding consumer configuration change.

## Unsigned wallet package

`prepare_deployment.mjs --operator 0x... --sender 0x... --out /absolute/local/directory` requires the focused checks to pass for the exact source, validator and dependency lock. It binds the actual operator, sender, current nonce, predicted deployment address and exact constructor runtime. It checks the target chain, pending nonce, sender funding and an unused deployment address, then writes an unsigned zero-value EIP-1559 transaction, compiler input and ABI. It has no signing-key input or broadcast method. Keep the operator-specific output outside this public source directory.

The package expires after 15 minutes. It allocates at most 0.01 ETH to deployment and reserves the other 0.01 ETH of the conditional budget for the first report. Actual gas/fee limits are much lower when supported by the live quote. The wallet holder must review and approve the transaction. An actual report transaction remains pending until its artifacts and operator signature exist.

## Data and trust boundary

Store the complete trajectory, scientific report, and exact input artifacts outside the contract. Hash a canonical encoding of each artifact and include its hash in the signed report. Keep the artifacts available from durable storage and publish a content-addressed copy. A wallet controlling the immutable operator key can attest to any hashes, so independent replication or a future proof verifier is needed for stronger scientific assurance.
