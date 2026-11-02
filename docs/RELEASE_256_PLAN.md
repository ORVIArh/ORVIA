# Mainnet-only 256-contract unsigned release candidate

The [release adapter](../scripts/deployment/release256.mjs) prepares a reproducible **unsigned infrastructure plan** for Robinhood mainnet **4663 only**. It has no wallet/key input, signer, transaction-send method or public-testnet route. The public sender is the user-authorized `0x2541a9e93B5C853E9208b0C5C7386dD458424c77`. Public sender and address-collision observations remain separate, time-dependent evidence; they are not fee quotes or complete deployment rehearsals.

The result is deliberately `prepared-but-blocked`, `readyForMainnet:false`, `completeProductionPlan:false`, with scientific and complete-validation acceptance false. No selected scientific protocol hashes or full production input manifest are invented. The [public draft specification](../evidence/256-release/draft-spec.json) leaves protocol and inputs unresolved. Its nonce is a dated preparation input and must be refreshed before any deployment. The adapter supports explicitly supplied unaccepted proposal or synthetic protocol/stream identities for integrity tests, without treating them as scientific approval.

## What is concrete

- Compile the current canonical 32-core dependency graph with pinned Solidity0.8.26, optimizer200, Shanghai. Bind source hashes, package/lock hashes, architecture, compiler/settings and the adapter itself. Reject duplicate deployable names and mismatched slot-to-source declarations.
- Derive exactly32 topologically ordered CREATE addresses from the declared public sender and first nonce. Role IDs distinguish the two `BankedWorkingState` routers and their immutable Pipeline/Hamiltonian writers.
- Execute each exact constructor as an offline `eth_call` with zero accounts, injecting only already derived dependency runtime code. Check every returned byte outside declared immutable offsets against its compiler template. Record full runtime witnesses and hashes for the planned addresses, rather than copying fixture immutables.
- Derive224 CREATE2 bank addresses from the actual child initcode, owning router and `bytes32(index)` salt. Execute each child constructor offline, so input-bank index and router/codehash immutables are bound. There are130 distinct runtime witnesses:32core,96 indexed input banks and one runtime per64-bank state pool.
- List56 bounded provisioning calls, exact Pipeline/constraint/spatial bindings, and protocol registration only when explicit hashes were supplied. Infrastructure has91 unsigned transactions with unresolved protocol; explicit protocol registration adds the92nd. The protocol registry lists32core modules; owning routers authenticate their224children.
- When supplied exact raw ABI-word files, compute the input pool commitment and chain4663/planned-router-bound stream rolling/sealed commitments, full upload nonce range and calldata fold. Zero-word files produce begin/seal only. Upload append batches contain at most128words. Every transaction is zero value, and all nonce ranges fail before uint64 exhaustion.

## Limits that stay blocked

Runtime injection does **not** reproduce constructor storage, initialize protocol mappings, or rehearse the binding/data state machine. These constructor runtime witnesses establish deterministic code/immutable identities under local Ethereum Shanghai execution; they do not prove target transaction admission, complete initialization or scientific behavior. The current C4 primitive remains standalone. Full model/topology/constraint/campaign registration, accepted parameter and alchemical policies, phase schedule, complete current-source validation, independent security acceptance, full-model target execution and gas/throughput/funding evidence remain required.

The public draft does not borrow fixture sender/protocol/input commitments. With no accepted model manifest it stops before topology/campaign registration and cannot quote full-model or full-campaign gas. `quote.available` is false. No mainnet transaction is submitted by preparation, verification or tests.

## APIs and commands

Run from the repository root with the repository's installed pinned dependencies:

```sh
node scripts/deployment/release256.mjs prepare \
  --root . --spec evidence/256-release/draft-spec.json \
  --out /tmp/orvia-256-unsigned-new.json

node scripts/deployment/release256.mjs verify \
  --root . --spec evidence/256-release/draft-spec.json \
  --plan /tmp/orvia-256-unsigned-new.json --out /tmp/orvia-256-integrity-new.json

node --test test/release256.test.mjs
```

Output files must not already exist. A verification pass means **integrity verified, still blocked**. The verifier requires an independently supplied intended public spec, rebuilds every artifact/address/calldata/runtime/input commitment, and rejects mutations even when their digest was recomputed.

`createInputMaterializer(plan,{root,spec,inputRoot,bundle?})` verifies once, freezes its own plan copy and captures the trusted compiler ABI. Its `transactionAt(index)` then reads at most4096 payload bytes per append and checks that chunk against the plan's bound SHA256. It does not reread/hash a complete large stream for every transaction. A changed chunk is rejected; an unchanged bound chunk remains valid if another chunk changes. Recreating/verifying the handle checks the entire word file again. Raw arbitrary-plan materialization is not exported.

An input manifest contains `purpose` (`candidate_unaccepted` or `synthetic_test_only`), a nonzero `modelId`, and stream descriptors `{id,role,wordsFile,sha256,totalWords}`. Files contain consecutive32-byte ABI words in binary form; paths are relative to an explicit `--input-root` and child symlinks are rejected. This adapter does not reinterpret native scientific formats. Zero-count topology roles may still require a zero stream ID under the topology catalog; a sealed named empty catalog stream is not an automatic substitute.

`checkMainnetState(plan,readRpc,verification)` first verifies the intended release, then permits only chain/block/code/nonce reads. It checks chain4663, a pinned block, EOA sender, pinned and pending sender nonce, all256 code/nonce collisions, the final pinned block hash and a second pending-nonce check after the long scan. It sends nothing and does not check funding or fees. Current tests use mocks for the full scan; only the separate sender observer contacted the mainnet provider.

## Release acceptance

The focused test writes `reports/release256_validation.json`; the complete local validation runner includes this test and binds its generated report. A targeted pass establishes the stated plan-integrity checks only. The source-bound complete suite and scientific acceptance remain separate gates.

The existing deployment command still refuses to authorize the active 256-contract system through its older 64-slot gate. This adapter does not replace or weaken that restriction. A complete accepted production topology/campaign manifest and stateful mainnet-pinned initialization rehearsal remain required. Mainnet-only read-only transaction estimates can be attached to exact stages once their required state exists. A future signer must independently reverify the complete exact plan, fresh nonce/collisions, source/runtime state and fees; signing is outside this adapter.
