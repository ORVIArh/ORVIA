# Target-provider creation of the large coordinators

On 2 November 2026, the documented Pinax Robinhood provider returned byte-identical deployed runtime for both large coordinators through contract-creation `eth_call`:

| Contract | Creation data bytes | Returned runtime bytes |
|---|---:|---:|
| MolecularSimulationPipeline | 42,808 | 40,945 |
| AlchemicalHamiltonianEvaluator | 37,454 | 34,449 |

The provider reported chain 4663. All calls used block `0x635744a`, hash `0xf2ca2859df1270a89f4d36527d0fe9c4e73b89edfc4d881793cf460ad6ab5989`; its hash and state root matched on the final check. Dependency runtime code from the local 32-core deployment was supplied through temporary state overrides. All 32 fixture addresses were empty at that pinned target state. No storage was transplanted, signer loaded, transaction broadcast or persistent contract created.

The [report](../reports/target_256_creation_probe.json) binds the probe source, complete runtime-input file, compilation provenance, 38 read-only requests/responses, creation data and expected/returned runtime hashes. The input inventory intentionally says `deployed_local_pending_integration`: it was captured after deployment and before the separate connected integration test finished. Creation compatibility does not depend on treating that pending integration as passed.

Reproduce with the pinned repository dependencies:

```sh
node scripts/probe256_creation.mjs . evidence/256-contract-creation/deployment-runtime-input.json /tmp/orvia-target-creation.json
```

The harness permits only chain/block/code/nonce reads and `eth_call`, rejects redirects and invalidates prior success before starting. It probes a fresh block on each invocation. The [manifest](../evidence/256-contract-creation/manifest.json) preserves the exact published input, script and report. It compares against recorded local runtimes rather than independently recompiling them.

[Robinhood's documentation](https://docs.robinhood.com/chain/differences-from-ethereum/#contract-size-limit) states a 96 KB code limit and 192 KB initcode limit. This probe supplements those documented limits with actual provider-observed creation behavior for the tested bytes. Simulation rules may differ from transaction admission or gas accounting. It does not establish a mainnet deployment, complete engine execution, transaction fees, sustained throughput, scientific sampling or production readiness.
