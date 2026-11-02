# Robinhood Chain Stylus/WASM review

Reviewed **2026-11-01 UTC**. Informational primary-source research only; no source changes, compilation, deployment, activation, funds or new RPC probes.

**Finding:** Robinhood-specific documentation supports Stylus as an architecture option. It is more than an inference from generic Arbitrum compatibility. However, **new Stylus activation on Robinhood mainnet chain 4663 has not been verified by this project today**. No ORVIA WASM implementation or gas benchmark exists, and this review does not establish a production-ready optimization.

## Evidence specific to Robinhood

| Primary source | What it establishes |
|---|---|
| [Robinhood protocol contracts](https://docs.robinhood.com/chain/protocol-contracts/) | The current table explicitly lists **ArbWasm** at `0x0000000000000000000000000000000000000071` and **ArbWasmCache** at `0x0000000000000000000000000000000000000072` for both Robinhood mainnet and testnet. This documents the Stylus interfaces on the intended chain. Precompile addresses alone do not prove current activation permissions. |
| [Arbitrum Foundation: Build Your First Robinhood Chain App](https://blog.arbitrum.foundation/build-your-first-dapp-on-robinhood-chain/), July 21, 2026 | In its Robinhood-specific discussion, the Foundation states: “Stylus lets a Solidity contract call a Rust one.” The article discusses both testnet deployment and mainnet configuration. This is direct primary evidence of intended Robinhood Stylus support. |
| [Robinhood node documentation](https://docs.robinhood.com/chain/run-a-full-node/) | Describes Robinhood as Nitro-based and currently running ArbOS 61. This is supporting context, not an independent test of Stylus activation. |

## Current activation uncertainty

The [official Arbitrum activation-pause notice](https://docs.arbitrum.io/notices/stylus-activation-pause-notice) currently identifies **Arbitrum One and Arbitrum Nova**: new/expired programs cannot be activated there during the pause, while already activated programs remain callable until expiry and may be renewed before expiry. The notice does **not** name Robinhood Chain. It would be incorrect either to extend that pause automatically to Robinhood or to infer that Robinhood's new activations are definitely available.

The [official activation guide](https://docs.arbitrum.io/stylus/concepts/activation) distinguishes storing compressed WASM on-chain from activation through ArbWasm. A deployed WASM code account is not enough to make the program executable. Activation state, protocol version, expiration and chain-specific limits matter separately.

ORVIA's existing public-RPC preflight returned HTTP 403 and has no observed chain ID or validated target fork. We have not read Robinhood's current Stylus parameters, simulated activation against chain 4663, or called an independently verified active mainnet Stylus program. Consequently the classification is **documented chain-specific support; present new-program activation availability unverified**, not unsupported and not confirmed operational for this project.

## Would software binary128 remain fully on-chain?

**Yes in principle, conditional on supported activation/execution and a valid implementation.** This is an architectural inference from the official [Stylus execution description](https://docs.arbitrum.io/stylus/gentle-introduction): WASM programs execute as smart contracts in the chain runtime and can call, or be called by, Solidity contracts. Performing the numerical work inside that deployed program, with protocol inputs/state and outputs committed on-chain, would satisfy the same on-chain computation boundary. Compiling Rust off-chain does not turn the contract's eventual numerical execution into off-chain calculation.

This would need **software arithmetic**, not an assumption that native floating-point instructions are available. The [official WASM documentation](https://docs.arbitrum.io/stylus/concepts/webassembly) lists integer arithmetic instructions and explicitly marks native `f32`/`f64` operations unsupported. An integer-backed binary128 implementation can in principle target those supported integer operations. No particular Rust library, compiler output or binary128 implementation has been validated here.

An ORVIA port would still need pinned numerical/library/compiler provenance, explicit finite and zero conventions, deterministic operation order, bounded execution and memory, exact input/output encoding, numerical equivalence/reference tests, activation-lifecycle handling, and a real gas benchmark on an appropriate Nitro/Stylus environment. Existing Ganache/EVM tests do not validate WASM execution. Chain-state reads and writes, transaction scheduling and full-system scientific requirements remain part of the workload.

**No speedup factor is inferred from generic Stylus marketing or native-code benchmarks.** The software-binary128 kernel, Solidity/WASM call overhead, activation cost and complete simulation workload have not been measured. This is a documented research direction beyond Solidity inlining, not a completed port, deployment plan or reason to clear the mainnet readiness gate.
