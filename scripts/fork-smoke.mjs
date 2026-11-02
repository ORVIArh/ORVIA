import fs from 'node:fs';
import { runForkSmoke, httpsForkReader } from './deployment/fork.mjs';

const output = 'reports/target_fork_smoke.json';
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(output, JSON.stringify({ status: 'in_progress', mainnetTransactionsSent: 0,
  productionReady: false, startedAtUtc: new Date().toISOString() }, null, 2) + '\n');
try {
  if (process.argv.length > 2) throw new Error('Configure ORVIA_RPC_URL and optional ORVIA_FORK_BLOCK; no signing or broadcast arguments are accepted');
  const endpoint = process.env.ORVIA_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const report = await runForkSmoke({ rpc: httpsForkReader(endpoint), blockTag: process.env.ORVIA_FORK_BLOCK || 'latest' });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, sourceBlock: report.sourceChain.number,
    sourceBlockHash: report.sourceChain.hash, mainnetTransactionsSent: 0, report: output }));
} catch (error) {
  // The transport sanitizes network errors before they reach this boundary.
  fs.writeFileSync(output, JSON.stringify({ status: 'blocked_or_failed', productionReady: false,
    checkedAtUtc: new Date().toISOString(), mainnetTransactionsSent: 0, error: error.message }, null, 2) + '\n');
  console.error(JSON.stringify({ status: 'blocked_or_failed', error: error.message, report: output }));
  process.exitCode = 2;
}
