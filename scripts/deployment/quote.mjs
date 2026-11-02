import { getAddress, keccak256 } from 'ethers';
import { TARGET_CHAIN_ID, INITCODE_LIMIT } from './release.mjs';

const quantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const allowed = new Set(['chainId', 'from', 'to', 'data', 'value', 'nonce']);
export function validateUnsignedTransaction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unsigned transaction must be an object');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported unsigned transaction field: ${key}`);
  if (input.chainId !== TARGET_CHAIN_ID) throw new Error('Quote target must be Robinhood mainnet 4663');
  const from = getAddress(input.from);
  if (/^0x0{40}$/i.test(from)) throw new Error('A nonzero public operator address is required');
  const data = input.data || '0x';
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data) || (data.length - 2) / 2 > INITCODE_LIMIT) throw new Error('Invalid or oversized transaction data');
  const value = input.value || '0x0';
  if (!quantity(value) || (input.nonce !== undefined && !quantity(input.nonce))) throw new Error('Value/nonce must be canonical hexadecimal quantities');
  const tx = { from, data, value };
  if (input.to !== undefined) tx.to = getAddress(input.to);
  else if (data === '0x') throw new Error('A creation transaction requires initcode');
  if (input.nonce !== undefined) tx.nonce = input.nonce;
  return tx;
}

export async function quoteTransaction(input, rpc) {
  const tx = validateUnsignedTransaction(input);
  const chain = await rpc('eth_chainId', []);
  if (!quantity(chain) || BigInt(chain) !== BigInt(TARGET_CHAIN_ID)) throw new Error('RPC chain ID does not match Robinhood mainnet');
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!latest?.hash || !quantity(latest.number)) throw new Error('RPC did not return a valid quote reference block');
  if (tx.nonce === undefined) tx.nonce = await rpc('eth_getTransactionCount', [tx.from, 'pending']);
  if (!quantity(tx.nonce)) throw new Error('RPC returned invalid pending nonce');
  const gasPrice = await rpc('eth_gasPrice', []);
  const estimate = await rpc('eth_estimateGas', [tx, 'pending']);
  const balance = await rpc('eth_getBalance', [tx.from, 'pending']);
  if (![gasPrice, estimate, balance].every(quantity) || BigInt(gasPrice) === 0n || BigInt(estimate) === 0n) throw new Error('RPC returned invalid gas/balance quantities');
  const gasBudget = (BigInt(estimate) * 120n + 99n) / 100n;
  const fee = BigInt(gasPrice) * BigInt(estimate), budget = BigInt(gasPrice) * gasBudget;
  return { schemaVersion: 1, chainId: TARGET_CHAIN_ID, readOnly: true, transactionsSent: 0,
    quotedAtUtc: new Date().toISOString(), referenceBlockNumber: latest.number, referenceBlockHash: latest.hash,
    from: tx.from, to: tx.to || null, nonce: tx.nonce, transactionValueWei: BigInt(tx.value).toString(),
    transactionDataKeccak256: keccak256(tx.data), transactionDataBytes: (tx.data.length - 2) / 2,
    gasEstimateIncludingL1Data: BigInt(estimate).toString(), gasPriceWei: BigInt(gasPrice).toString(),
    estimatedFeeWei: fee.toString(), gasBudgetWith20PercentMargin: gasBudget.toString(), feeBudgetAtQuotedGasPriceWei: budget.toString(),
    balanceWei: BigInt(balance).toString(), balanceCoversQuotedBudgetAndValue: BigInt(balance) >= budget + BigInt(tx.value),
    scope: 'One exact unsigned transaction against current pending state; re-estimate immediately before signing. This does not quote undeployed dependent contracts or a complete production workflow.' };
}

export function readOnlyRpc(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS endpoint without embedded user credentials');
  const methods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_estimateGas', 'eth_getBalance']);
  let serial = 0;
  return async (method, params) => {
    if (!methods.has(method)) throw new Error('Non-read-only RPC method refused');
    const id = ++serial;
    let response;
    try { response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(20_000) }); }
    catch { throw new Error(`${method}: RPC transport failed`); }
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error(`${method}: invalid RPC JSON`); }
    if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !('result' in body)) throw new Error(`${method}: invalid/error RPC response`);
    return body.result;
  };
}
