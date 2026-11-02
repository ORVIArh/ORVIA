// Read-only first-use gate for the explicitly authorized market-fee recovery.
// It accepts only the original four signed entries, never opens a wallet, and
// never permits a broadcast. The sender repeats race checks under its own lock.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {verifyPlan, normalizeSpec} from './hybrid256.mjs';
import {readDeploymentJournal, validateJournal} from './hybrid_operator.mjs';
import {deploymentRpc, verifyDeployedPrefix} from './hybrid_operator_reliable.mjs';
import {readPrivateFile} from '../../experimental/mainnet-lite/local_wallet.mjs';

const PLAN = '814e9c0aced4f8c6ef24bf4ca7fe5d423ef8bb4e4d54216a3dea02484958b50c';
const SAVED = '0xf8f37c49df70ba6581b2620a47558c5b505139afe27a0b299f591abc7f09515b';
const must = (condition, message) => { if (!condition) throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  must(process.argv.length === 3, 'A frozen release directory is required.');
  const release = path.resolve(process.argv[2]);
  const plan = JSON.parse(fs.readFileSync(path.join(release, 'plan.json')));
  const spec = normalizeSpec(JSON.parse(fs.readFileSync(path.join(release, 'spec.json'))));
  must(plan.planSha256 === PLAN, 'Unexpected plan.');
  const {bundle} = verifyPlan(plan, undefined, spec);
  const home = os.userInfo().homedir;
  const journalPath = path.join(home, '.orvia', 'deployments', PLAN + '.json');
  const before = hash(fs.readFileSync(journalPath));
  const journal = readDeploymentJournal(journalPath);
  validateJournal(journal, plan, spec); // All four originals retain their old guards.
  must(journal.entries.length === 4 && journal.completed === false,
    'This first-use gate requires exactly the four original signed entries.');
  must(journal.entries[3].transactionHash === SAVED, 'Unexpected saved transaction.');

  const provider = deploymentRpc(readPrivateFile(path.join(home, '.orvia', 'rpc',
    'robinhood-mainnet-alchemy.url')).trim());
  const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
    'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_call',
    'eth_gasPrice', 'eth_getBalance']);
  const rpc = (method, params = []) => {
    must(allowed.has(method), 'Read-only method restriction.');
    return provider(method, params);
  };
  must(BigInt(await rpc('eth_chainId')) === 4663n, 'Wrong chain.');
  let confirmed = 0;
  let paid = 0n;
  for (const entry of journal.entries) {
    const receipt = await rpc('eth_getTransactionReceipt', [entry.transactionHash]);
    if (!receipt) {
      must(entry.index === 3, 'A prior receipt is missing.');
      break;
    }
    must(receipt.transactionHash === entry.transactionHash && receipt.status === '0x1',
      'Invalid or failed receipt.');
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    must(block?.hash === receipt.blockHash
      && BigInt(latest.number) >= BigInt(receipt.blockNumber) + 2n,
      'Receipt must have two canonical confirmation blocks.');
    paid += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    confirmed++;
  }
  must(confirmed === 3 || confirmed === 4, 'Unexpected confirmed prefix.');
  await verifyDeployedPrefix(plan, confirmed, rpc, bundle);
  const latestNonce = await rpc('eth_getTransactionCount', [spec.sender, 'latest']);
  const pendingNonce = await rpc('eth_getTransactionCount', [spec.sender, 'pending']);
  must(BigInt(latestNonce) === BigInt(confirmed)
    && BigInt(pendingNonce) === BigInt(confirmed), 'Nonce changed; inspect before unlocking.');
  const market = BigInt(await rpc('eth_gasPrice'));
  must(market > 0n, 'Invalid market price.');
  const balance = BigInt(await rpc('eth_getBalance', [spec.sender, 'pending']));
  const buffered = value => (value * 125n + 99n) / 100n;
  let estimate = paid;
  for (let index = confirmed; index < 33; index++) {
    const old = index === 3 ? BigInt(journal.entries[3].gasPriceWei) : 0n;
    const price = buffered(old > market ? old : market);
    estimate += BigInt(journal.initialQuote.estimates[index].gasIncludingL1Data) * price;
  }
  must(hash(fs.readFileSync(journalPath)) === before, 'Journal changed during verification.');
  console.log(JSON.stringify({schema: 'orvia.hybrid256.market-recovery-gate.v1',
    recoveryVerified: true, confirmedPrefix: confirmed, signedEntries: 4,
    savedHash: SAVED, latestNonce, pendingNonce, planSha256: PLAN,
    journalSha256: before, currentMarketGasPriceWei: market.toString(),
    balanceWei: balance.toString(), confirmedFeeWei: paid.toString(),
    indicativeFullInfrastructureFeeWei: estimate.toString(),
    estimateScope: 'Confirmed receipt fees plus original remaining gas estimates at current market price with 25% margin; not a fresh gas quote or campaign total.',
    priceCap: null, publicTransactionsSent: 0}));
}

main().catch(() => {
  console.error('Read-only market recovery verification failed; no transaction was sent.');
  process.exitCode = 2;
});
