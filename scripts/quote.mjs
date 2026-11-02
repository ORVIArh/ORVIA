import fs from 'node:fs';
import { quoteTransaction, readOnlyRpc } from './deployment/quote.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/quote.mjs unsigned-transaction.json');
  const input = JSON.parse(fs.readFileSync(process.argv[2]));
  const endpoint = process.env.ORVIA_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const report = await quoteTransaction(input, readOnlyRpc(endpoint));
  fs.writeFileSync('reports/live_fee_quote.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: 'reports/live_fee_quote.json', estimatedFeeWei: report.estimatedFeeWei,
    balanceCoversQuotedBudgetAndValue: report.balanceCoversQuotedBudgetAndValue, transactionsSent: 0 }));
} catch (error) { console.error(error.message); process.exitCode = 2; }
