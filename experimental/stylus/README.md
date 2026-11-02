# Rejected Stylus activation experiment

This separate, unadmitted experiment investigated a binary128-format integer-backed Rust/APFloat kernel as an alternative to Solidity arithmetic. It has a distinct nearest-even numerical policy and is not bitwise equivalent to ABDK. It is excluded from the Solidity campaign implementation and its offline validation inventory.

On 2 November 2026, `cargo-stylus` 0.10.10's read-only activation check against the credential-free Robinhood Pinax endpoint returned an activation gas charge of **18446744073709551615**, with the explicit error that activations appear paused. This blocks new deployment/activation of this experiment. Precompile version/ink-price replies alone do not demonstrate that activation is enabled. No persistent deployment, activation or other mainnet transaction was sent. No WASM execution or gas improvement is established by a successful compilation.

The pinned Rust dependencies are in `quad-kernel/Cargo.lock`; the wrapper is MIT and dependencies retain their own licenses (including rustc_apfloat's Apache/LLVM license). Rust 1.99.1 built the wasm32-unknown-unknown release artifact. The checked WASM was 55,747 bytes; cargo-stylus reported 18,427 compressed bytes. The artifact, exact source hashes, activation log and separate parameter observations are retained for reproducibility. Two native arithmetic smoke tests passed; they are not the Solidity scientific validation suite or comprehensive WASM validation.

From `quad-kernel`, reproduce the native smoke checks and cross-compilation with:

```sh
cargo test --locked
cargo build --locked --release --target wasm32-unknown-unknown
cargo stylus check --wasm-file target/wasm32-unknown-unknown/release/orvia_quad_kernel.wasm --endpoint https://robinhood.rpc.pinax.network
```

The `check` command uses simulation. Do not substitute `deploy` or `activate` when reproducing this observation. The online parameter script is run from the ORVIA project root as `node experimental/stylus/scripts/parameters.mjs` and writes `reports/stylus_parameters.json`. Chain conditions can change; a future activation claim requires a fresh actual check. The current Solidity route does not depend on this blocked experiment.
