# Block-pinned local state-fork smoke check

The runner seeds a local Ganache chain from an observed Robinhood mainnet block, deploys `FloatMath` and `InlineNonbondedKernel` locally, checks runtime against source, and evaluates exact scalar/pair examples. **This is a numerical-kernel smoke check on a state fork, not a full Robinhood execution-client or molecular experiment validation.**

```sh
ORVIA_RPC_URL=https://robinhood.rpc.pinax.network node scripts/fork-smoke.mjs
# To replay a recorded height, also set ORVIA_FORK_BLOCK to its hexadecimal number.
```

The provider above is linked from Robinhood's [official connection documentation](https://docs.robinhood.com/chain/connecting/). Availability can change; configure an HTTPS archive-capable endpoint privately if a recorded height cannot be served. Provider URLs and paths are not saved by this runner.

The [report](../reports/target_fork_smoke.json) records source chain 4663, block number/hash/state root, compiler settings, source and harness hashes, exact local deployment runtimes, local transaction hashes/gas, numerical outputs, and upstream method counts. The remote block identity is checked again at completion. Interrupted runs invalidate the prior success before work begins.

Only allowlisted remote reads can reach the upstream. `eth_sendTransaction`, raw broadcast, signing, wallet and administrative methods are rejected before dispatch. All deployment transactions use an ephemeral deterministic development account on local chain **31337**. No mainnet private key is used and no mainnet transaction is sent.

Offline boundary tests cover wrong-chain rejection, malformed/mismatched block identities, a changing reference block, and refusal to transmit mutations. Run `node --test test/fork-boundary.test.mjs`. Network-dependent smoke execution is separate from the nine offline validation groups.

## Interpretation

Ganache applies its local **Ethereum Shanghai rules**, a 30-million local block gas limit, and ordinary Ethereum code-size rules. It does not run Robinhood's Nitro execution client or establish target-specific precompiles, limits, fees or sustained throughput. The recorded state root identifies the RPC-supplied snapshot; this tool does not independently verify state proofs. Its gas measurements omit Robinhood L1 data fees.

A successful result cannot satisfy the full-model production gate. That still requires the complete accepted systems and protocol, target execution-client checks, phase-complete gas/workload measurements, independent review, and a reviewed public deployment plan. No explorer source-verification submission occurs here.
