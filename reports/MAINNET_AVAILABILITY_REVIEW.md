# Robinhood Chain mainnet availability review

Reviewed **2026-11-01, approximately 20:12 UTC** (2026-11-02 in India). Read-only official-source review; no authentication, funds, signing, deployment or new RPC probe.

**Finding:** Robinhood publicly announced mainnet launch on **July 1, 2026**, and its current documentation and linked service-status page describe an available mainnet. There is no basis in the reviewed sources to label the chain itself an unlaunched preview. ORVIA's own target-chain access and execution verification remain blocked/incomplete.

| Primary source | Evidence and interpretation |
|---|---|
| [Robinhood launch announcement](https://robinhood.com/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/), July 1, updated July 30, 2026 | Explicit statement: “We are officially launching the Public Mainnet of Robinhood Chain.” This is a launch announcement, beyond a table assigning a future chain ID. |
| [Current chain overview](https://docs.robinhood.com/chain/) | Says “Robinhood Chain is live.” It describes application development and contract deployment as permissionless. |
| [Officially linked status page](https://status.robinhoodchain.offchain.io/) | At retrieval, mainnet and testnet were separately marked operational. A node-upgrade notice was dated October 27, 2026. This is operator-reported service status, not our own chain-state verification. |
| [Connecting documentation](https://docs.robinhood.com/chain/connecting/) | Lists mainnet chain ID 4663, ETH gas, the public RPC and explorer, and production provider endpoints. Public endpoints are rate-limited and not recommended for production; provider access uses that provider's account/API key. |
| [Deployment documentation](https://docs.robinhood.com/chain/deploy-smart-contracts/) | Gives ordinary mainnet deployment steps and requires a wallet holding ETH on Robinhood Chain. The guide does not list a deployer allowlist or preview invitation. No deployment command was executed here. |
| [Governance](https://docs.robinhood.com/chain/governance/) and [node operation](https://docs.robinhood.com/chain/run-a-full-node/) | Dispute validators are permissioned; operating one requires an allowlist and bond. That validator role is distinct from application deployment. ORVIA does not need to become a dispute validator to deploy contracts. |

An additional current primary-source search result, Robinhood's [10-Q filed October 28, 2026](https://investors.robinhood.com/static-files/700736bb-91f8-456e-9798-0ba1c2aadd9c), describes the July 2026 launch in past tense and says developers in supported jurisdictions can deploy without Robinhood approval. The indexed excerpt was retrieved, but opening the full PDF returned HTTP 403. It is supplementary corroboration; the conclusion above also rests on fully retrieved official announcement/documentation/status pages.

Public deployment does not mean every provider service is unrestricted. The [service terms, updated August 24, 2026](https://docs.robinhood.com/chain/terms-of-service/) state eligibility/access conditions and permit public-RPC throttling or suspension. They distinguish Robinhood-operated access services from the chain's protocol contracts. No inference about this operator's jurisdiction or eligibility is made, and no restriction was bypassed. Product-specific Stock Token availability is also distinct from generic contract deployment.

## What was actually observed from this environment

The unchanged `reports/mainnet_preflight.json` records **2026-11-01T19:31:54.553850Z**: `eth_chainId`, `eth_getBlockByNumber` and `eth_gasPrice` each returned **HTTP 403** from the documented public RPC. `chain_id_observed` is null; no target fork was validated; transactions sent remain zero. This review did not repeatedly retry that endpoint.

The [documented explorer homepage](https://robinhoodchain.blockscout.com/) returned an explorer page title through web retrieval but no readable block/transaction data. Its public stats URL was inaccessible through the retrieval tool. We therefore have **not independently observed a current mainnet block height, code state, gas limit, gas price, sustained application throughput or successful deployment**.

The precise external blocker is **working authorized RPC/fork/fee/capacity verification for ORVIA**, not evidence that Robinhood mainnet has yet to launch. A public launch announcement and an operational status page cannot substitute for those measurements. They also do not resolve ORVIA's incomplete full-system integration, prepared-model validation or workload feasibility.

All links above are primary sources or the explorer/status services linked by the official documentation. Retrieval limitations are stated explicitly; web availability is not on-chain execution evidence.
