// User-run local deployment. No secret arguments, environment variables, or cloud signing.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Interface, Transaction, getAddress, keccak256, toQuantity} from 'ethers';
import {CHAIN_ID, canonical, normalizeSpec, verifyPlan, verifyRehearsal, quoteHybrid} from './hybrid256.mjs';
import {walletLocation, secureDirectory, readPrivateFile, decryptVerified,
  withHiddenSession, hiddenPrompt, SafeError} from '../../experimental/mainnet-lite/local_wallet.mjs';

const requireSafe = (ok, message) => { if (!ok) throw new SafeError(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantity = value => {
  requireSafe(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'Invalid RPC quantity.');
  return BigInt(value);
};
const decimal = value => {
  requireSafe(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'Invalid journal quantity.');
  return BigInt(value);
};
const isHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

export function readDeploymentJournal(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireSafe(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= MAX_JOURNAL_BYTES,
      'Unsafe deployment journal.');
    const bytes = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    requireSafe(length <= MAX_JOURNAL_BYTES, 'Deployment journal is too large.');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

export function validateJournal(journal, plan, spec) {
  requireSafe(journal?.schema === 'orvia.hybrid256.deployment.v1' && journal.planSha256 === plan.planSha256
    && canonical(journal.spec) === canonical(spec) && Array.isArray(journal.entries)
    && journal.entries.length <= 33 && typeof journal.completed === 'boolean', 'Journal belongs to a different release.');
  const quote = journal.initialQuote;
  requireSafe(quote?.schema === 'orvia.hybrid256.quote.v1' && quote.planSha256 === plan.planSha256
    && quote.chainId === CHAIN_ID && quote.sender === spec.sender
    && quantity(quote.nonce) === BigInt(spec.firstNonce) && quote.actualContracts === 256
    && quote.infrastructureTransactions === 33 && quote.publicTransactionsSent === 0
    && quote.conditional === true && quote.fullCampaignTotalWei === null
    && isHash(quote.referenceBlock?.hash) && Array.isArray(quote.estimates) && quote.estimates.length === 33,
    'Journal quote does not bind the reviewed deployment.');
  quantity(quote.referenceBlock.number);
  decimal(quote.balanceWei);
  const price = decimal(quote.gasPriceWei);
  requireSafe(price > 0n, 'Invalid journal gas price.');
  let gasTotal = 0n;
  for (let index = 0; index < 33; index++) {
    const estimate = quote.estimates[index];
    const gas = decimal(estimate.gasIncludingL1Data);
    requireSafe(estimate.index === index && estimate.kind === plan.transactions[index].kind
      && estimate.usesLocalPredecessorStateOverrides === (index > 0) && gas > 21000n
      && decimal(estimate.feeWeiAtObservedPrice) === gas * price, 'Journal quote estimate mismatch.');
    gasTotal += gas;
  }
  requireSafe(decimal(quote.totalInfrastructureGasIncludingL1Data) === gasTotal
    && decimal(quote.totalInfrastructureFeeWei) === gasTotal * price, 'Journal quote total mismatch.');
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index];
    requireSafe(entry.index === index, 'Journal entry order mismatch.');
    const tx = validateSignedEntry(entry, plan.transactions[index].transaction, spec.sender);
    requireSafe(tx.gasPrice <= price * 2n
      && tx.gasLimit <= decimal(quote.estimates[index].gasIncludingL1Data) * 2n,
      'Journal signed fees exceed the original quote guards.');
  }
  requireSafe(!journal.completed || journal.entries.length === 33, 'Incomplete journal marked complete.');
  return {maxGasPrice: price * 2n};
}

export function deploymentRpc(url) {
  const parsed = new URL(url);
  requireSafe(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'HTTPS RPC required.');
  const allowed = new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getBalance',
    'eth_getTransactionCount','eth_gasPrice','eth_estimateGas','eth_call',
    'eth_getTransactionReceipt','eth_getTransactionByHash','eth_sendRawTransaction']);
  let id = 0;
  return async (method, params = []) => {
    requireSafe(allowed.has(method), 'RPC method not permitted.');
    const serial = ++id;
    const readOnly = method !== 'eth_sendRawTransaction';
    const attempts = readOnly ? 3 : 1;
    const failed = () => new SafeError('RPC failed during ' + method + '; no automatic transaction replacement.');
    for (let attempt=0; attempt<attempts; attempt++) {
      let response;
      try {
        response = await fetch(url, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:serial,method,params}),signal:AbortSignal.timeout(30000)});
      } catch {
        if (attempt+1===attempts) throw failed();
        await delay(200*(attempt+1)); continue;
      }
      if (!response.ok) {
        const transient = response.status===408 || response.status===429 || (response.status>=500 && response.status<=599);
        if (readOnly && transient && attempt+1<attempts) {
          const header=response.headers?.get('retry-after');
          const waitSeconds=header && /^\d+$/.test(header) ? Math.min(Number(header),2) : 0;
          try { await response.body?.cancel(); } catch {}
          await delay(Math.max(200*(attempt+1),waitSeconds*1000)); continue;
        }
        throw failed();
      }
      let data;
      try { data=await response.json(); } catch { throw failed(); }
      if (data.jsonrpc!=='2.0' || data.id!==serial || data.error || !Object.hasOwn(data,'result')) throw failed();
      return data.result;
    }
    throw failed();
  };
}

export function validateSignedEntry(entry, intended, sender) {
  requireSafe(entry && typeof entry.rawTransaction === 'string' && isHash(entry.transactionHash),
    'Invalid signed journal entry.');
  const tx = Transaction.from(entry.rawTransaction);
  requireSafe(tx.isSigned() && tx.hash === entry.transactionHash && tx.from === sender,
    'Journal signature or sender mismatch.');
  requireSafe(tx.chainId === BigInt(CHAIN_ID) && tx.type === 0 && tx.value === 0n
    && tx.nonce === Number(BigInt(intended.nonce)) && tx.data === intended.data
    && tx.to === (intended.to || null) && tx.gasLimit > 21000n && tx.gasPrice > 0n,
    'Journal transaction differs from the reviewed deployment.');
  requireSafe(tx.gasLimit === decimal(entry.gasLimit) && tx.gasPrice === decimal(entry.gasPriceWei),
    'Journal fee fields disagree.');
  return tx;
}

export async function verifyDeployedPrefix(plan, count, rpc, bundle) {
  requireSafe(Number.isInteger(count) && count >= 0 && count <= 33, 'Invalid deployment prefix.');
  const iface = new Interface(bundle.artifacts.ORVIAHybridCoordinator.abi);
  const reference = await rpc('eth_getBlockByNumber', ['latest', false]);
  requireSafe(isHash(reference?.hash), 'Invalid deployment verification block.');
  quantity(reference.number);
  const blockTag = reference.number;
  const call = async (name,args=[]) => iface.decodeFunctionResult(name,
    await rpc('eth_call',[{to:plan.coordinator,data:iface.encodeFunctionData(name,args)},blockTag]));
  const created = count === 0 ? 0 : 1 + Math.min(255,(count-1)*8);
  for (let start=0; start<plan.contracts.length; start+=8) {
    await Promise.all(plan.contracts.slice(start,start+8).map(async (contract,offset) => {
      const code = await rpc('eth_getCode',[contract.address,blockTag]);
      requireSafe(code === (start+offset<created ? contract.runtime : '0x'),
        'On-chain deployment inventory does not match this journal.');
      if (start+offset >= created) requireSafe(quantity(await rpc('eth_getTransactionCount',
        [contract.address,blockTag])) === 0n, 'Undeployed address has a nonce collision.');
    }));
  }
  if (count) {
    requireSafe(getAddress((await call('owner'))[0]) === plan.spec.owner
      && getAddress((await call('operator'))[0]) === plan.spec.operator
      && Number((await call('shardCount'))[0]) === created-1, 'Coordinator state mismatch.');
    for (let index=0;index<created-1;index++) {
      requireSafe(getAddress((await call('shards',[index]))[0]) === plan.contracts[index+1].address
        && (await call('shardCodeHash',[index]))[0] === plan.contracts[index+1].runtimeKeccak256,
        'Shard registration mismatch.');
    }
  }
  requireSafe((await rpc('eth_getBlockByNumber', [blockTag, false]))?.hash === reference.hash,
    'Deployment verification block changed.');
  return {verifiedContracts:created,complete:created===256};
}

export async function confirmedReceipt(hash, rpc, timeoutMs=600000) {
  const until = Date.now()+timeoutMs;
  while (Date.now()<until) {
    const receipt = await rpc('eth_getTransactionReceipt',[hash]);
    if (receipt) {
      requireSafe(receipt.transactionHash === hash && isHash(receipt.blockHash)
        && quantity(receipt.status) === 1n,
        'Transaction failed or returned an invalid receipt. Stop and inspect the journal.');
      const block = await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
      // Some RPC backends expose a receipt before indexing its block.
      // Only null is a transient absence: a conflicting canonical hash is fatal.
      if (block !== null) {
        requireSafe(block?.hash === receipt.blockHash, 'Receipt is no longer in the canonical chain.');
        const latest = await rpc('eth_getBlockByNumber',['latest',false]);
        if (latest !== null && quantity(latest.number) >= quantity(receipt.blockNumber)+2n) return receipt;
      }
    }
    await delay(2000);
  }
  throw new SafeError('Confirmation timed out. Keep the journal and rerun to reconcile; do not replace the transaction.');
}

export async function reconcileSignedEntry(entry, intended, sender, rpc, beforeRetransmit = async () => {}) {
  const tx = validateSignedEntry(entry, intended, sender);
  requireSafe(quantity(await rpc('eth_chainId')) === BigInt(CHAIN_ID), 'RPC chain changed.');
  // A receipt can remain available after a node stops indexing the transaction.
  const receipt = await rpc('eth_getTransactionReceipt', [entry.transactionHash]);
  if (receipt) return confirmedReceipt(entry.transactionHash, rpc);
  const known = await rpc('eth_getTransactionByHash', [entry.transactionHash]);
  if (known) {
    requireSafe(known.hash === entry.transactionHash && getAddress(known.from) === sender
      && quantity(known.nonce) === BigInt(intended.nonce), 'Known transaction identity mismatch.');
  } else {
    for (const tag of ['latest', 'pending']) requireSafe(quantity(await rpc('eth_getTransactionCount', [sender, tag]))
      === BigInt(intended.nonce), 'Unknown journal transaction has a consumed or pending nonce.');
    await beforeRetransmit();
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    requireSafe(tx.gasLimit <= quantity(block.gasLimit), 'Journal gas limit exceeds the current block.');
    requireSafe(quantity(await rpc('eth_getBalance', [sender, 'pending'])) >= tx.gasLimit * tx.gasPrice,
      'Insufficient balance to retransmit the saved transaction.');
    requireSafe(await rpc('eth_getCode', [sender, 'pending']) === '0x', 'Deployment sender must remain an EOA.');
    const {chainId, ...input} = intended;
    const estimated = quantity(await rpc('eth_estimateGas', [input, 'pending']));
    requireSafe(estimated > 21000n && estimated <= tx.gasLimit,
      'Saved transaction gas is no longer sufficient; no replacement was signed.');
    requireSafe(quantity(await rpc('eth_chainId')) === BigInt(CHAIN_ID)
      && quantity(await rpc('eth_getTransactionCount', [sender, 'pending'])) === BigInt(intended.nonce),
      'Network or nonce changed before retransmission.');
    requireSafe(await rpc('eth_sendRawTransaction', [entry.rawTransaction]) === entry.transactionHash,
      'Reconciled transaction hash mismatch.');
  }
  return confirmedReceipt(entry.transactionHash, rpc);
}

function saveJournal(file, value) {
  const serialized = JSON.stringify(value,null,2)+'\n';
  requireSafe(Buffer.byteLength(serialized) <= MAX_JOURNAL_BYTES, 'Deployment journal is too large.');
  const temporary=file+'.tmp-'+process.pid;
  const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try { fs.writeFileSync(fd,serialized); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary,file);
  const parent=fs.openSync(path.dirname(file),'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

// A margin applies only before the first signature for a new nonce.
// Saved transactions are always reconciled byte-for-byte, never fee-replaced.
export function firstSubmissionPrice(observedPrice,maxGasPrice) {
  requireSafe(typeof observedPrice==='bigint' && typeof maxGasPrice==='bigint'
    && observedPrice>0n && maxGasPrice>0n,'Invalid gas price input.');
  const price=(observedPrice*125n+99n)/100n;
  requireSafe(price<=maxGasPrice,'Gas price exceeds twice the initial quote; a new review is required.');
  return price;
}

export async function main(args=process.argv.slice(2)) {
  const [command,planFile,specFile,approvedHash]=args;
  requireSafe(args.length===4 && command==='deploy' && /^[0-9a-f]{64}$/.test(approvedHash||''),
    'Usage: node scripts/deployment/hybrid_operator.mjs deploy plan.json intended-spec.json PLAN_SHA256');
  const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
  const spec=normalizeSpec(JSON.parse(fs.readFileSync(specFile,'utf8')));
  requireSafe(plan.planSha256===approvedHash,'Plan hash differs from the reviewed release.');
  const {bundle}=verifyPlan(plan,undefined,spec);
  await verifyRehearsal(plan,spec);
  const location=walletLocation();
  secureDirectory(location.home,location.directory);
  const stateDirectory=path.join(location.home,'.orvia','deployments');
  secureDirectory(location.home,stateDirectory,true);
  const rpcDirectory=path.join(location.home,'.orvia','rpc');
  secureDirectory(location.home,rpcDirectory);
  const rpc=deploymentRpc(readPrivateFile(path.join(rpcDirectory,'robinhood-mainnet-alchemy.url')).trim());
  requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID),'Wrong chain; deployment refused.');
  for (const address of new Set([spec.sender,spec.operator]))
    requireSafe(await rpc('eth_getCode',[address,'pending'])==='0x','Deployment sender and operator must be EOAs.');
  const journalFile=path.join(stateDirectory,approvedHash+'.json');
  // All plans for this sender share a lock: two different plan hashes must not race a nonce.
  const lock=path.join(stateDirectory,CHAIN_ID+'-'+spec.sender.toLowerCase()+'.lock');
  let lockFd;
  try { lockFd=fs.openSync(lock,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600); }
  catch { throw new SafeError('A deployment lock exists. Confirm no other deployment is running before removing its lock.'); }
  try {
    let journal;
    if (fs.existsSync(journalFile)) {
      journal=readDeploymentJournal(journalFile);
    } else {
      const quote=await quoteHybrid(plan,rpc,undefined,spec);
      requireSafe(quote.balanceCoversEstimate,'Wallet balance does not cover all 256 contracts.');
      const reserved = quote.estimates.reduce((sum, entry) => sum
        + (decimal(entry.gasIncludingL1Data) * 125n + 99n) / 100n, 0n) * decimal(quote.gasPriceWei);
      requireSafe(decimal(quote.balanceWei) >= reserved,
        'Wallet balance does not cover all 33 transaction limits including the 25% gas margin.');
      journal={schema:'orvia.hybrid256.deployment.v1',planSha256:approvedHash,spec,initialQuote:quote,
        startedAtUtc:new Date().toISOString(),entries:[],completed:false};
      saveJournal(journalFile,journal);
    }
    const {maxGasPrice}=validateJournal(journal,plan,spec);
    for (let index=0;index<journal.entries.length;index++) {
      const entry=journal.entries[index];
      // A crash can occur after journalling and before send. Reconcile first, then
      // only retransmit the identical signed transaction at its still-unused nonce.
      entry.receipt=await reconcileSignedEntry(entry,plan.transactions[index].transaction,spec.sender,rpc,
        () => verifyDeployedPrefix(plan,index,rpc,bundle));
      saveJournal(journalFile,journal);
    }
    await verifyDeployedPrefix(plan,journal.entries.length,rpc,bundle);
    if (journal.entries.length===33) {
      journal.completed=true; journal.completedAtUtc=new Date().toISOString(); saveJournal(journalFile,journal);
      console.log('All 256 contract runtimes and registrations verified.'); return;
    }
    console.log('Deploying exactly 256 infrastructure contracts in 33 transactions. This does not certify a scientific campaign.');
    console.log('Release: '+approvedHash+'; completed transactions: '+journal.entries.length+'/33');
    await withHiddenSession(async()=>{
      let password=await hiddenPrompt('Local encrypted-wallet password (hidden): ');
      const wallet=await decryptVerified(readPrivateFile(location.file),password,spec.sender); password='';
      for (let index=journal.entries.length;index<33;index++) {
        requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID),'RPC chain changed.');
        const intended=plan.transactions[index].transaction;
        requireSafe(quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']))===BigInt(intended.nonce),
          'Wallet nonce changed; stop to reconcile other transactions.');
        const observedPrice=quantity(await rpc('eth_gasPrice'));
        const price=firstSubmissionPrice(observedPrice,maxGasPrice);
        const {chainId,...estimateInput}=intended;
        const gas=quantity(await rpc('eth_estimateGas',[estimateInput,'pending']));
        const limit=(gas*125n+99n)/100n;
        const block=await rpc('eth_getBlockByNumber',['latest',false]);
        requireSafe(gas>21000n&&limit<=quantity(block.gasLimit),'Gas estimate is invalid for the current block.');
        requireSafe(limit<=decimal(journal.initialQuote.estimates[index].gasIncludingL1Data)*2n,
          'Gas limit exceeds twice the original estimate; stop for a new quote review.');
        requireSafe(quantity(await rpc('eth_getBalance',[spec.sender,'pending']))>=limit*price,
          'Insufficient wallet balance for this transaction.');
        const raw=await wallet.signTransaction({type:0,chainId:CHAIN_ID,nonce:Number(BigInt(intended.nonce)),
          to:intended.to||null,value:0n,data:intended.data,gasLimit:limit,gasPrice:price});
        const entry={index,transactionHash:keccak256(raw),rawTransaction:raw,
          gasLimit:limit.toString(),gasPriceWei:price.toString(),signedAtUtc:new Date().toISOString()};
        validateSignedEntry(entry,intended,spec.sender);
        journal.entries.push(entry); validateJournal(journal,plan,spec); saveJournal(journalFile,journal);
        requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID)
          &&quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']))===BigInt(intended.nonce),
          'Network or nonce changed after signing; the saved transaction has not been broadcast.');
        requireSafe(await rpc('eth_sendRawTransaction',[raw])===entry.transactionHash,'RPC transaction hash mismatch.');
        entry.receipt=await confirmedReceipt(entry.transactionHash,rpc); saveJournal(journalFile,journal);
        console.log('Confirmed '+(index+1)+'/33: '+entry.transactionHash);
      }
    });
    const verified=await verifyDeployedPrefix(plan,33,rpc,bundle);
    journal.completed=verified.complete; journal.completedAtUtc=new Date().toISOString();
    saveJournal(journalFile,journal);
    console.log('All 256 contract runtimes and registrations verified. Journal: '+journalFile);
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error instanceof SafeError?error.message:'Deployment stopped. Preserve the journal for inspection.');process.exitCode=2;});
}
