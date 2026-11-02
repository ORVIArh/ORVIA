// User-run local deployment. No secret arguments, environment variables, or cloud signing.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Interface, Transaction, getAddress, keccak256, toQuantity} from 'ethers';
import {CHAIN_ID, canonical, normalizeSpec, verifyPlan, verifyRehearsal, quoteHybrid} from './hybrid256.mjs';
import {walletLocation, secureDirectory, readPrivateFile, decryptVerified,
  withHiddenSession, hiddenPrompt, SafeError} from '../../experimental/mainnet-lite/local_wallet.mjs';

import {marketQuote,feeEvidence,validateMarketJournal,resolveNonce3,readReplacementHistory} from './market_recovery.mjs';

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
    const failed = (transient=false) => {const error=new SafeError('RPC failed during ' + method + '; no automatic transaction replacement.');error.retryableRead=readOnly&&transient;return error;};
    for (let attempt=0; attempt<attempts; attempt++) {
      let response;
      try {
        response = await fetch(url, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:serial,method,params}),signal:AbortSignal.timeout(30000)});
      } catch {
        if (attempt+1===attempts) throw failed(true);
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
        throw failed(transient);
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

export async function confirmedReceipt(hash,rpc,timeoutMs=600000) {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until) {
    try {
      const receipt=await rpc('eth_getTransactionReceipt',[hash]);
      if(receipt) {
        requireSafe(receipt.transactionHash===hash&&isHash(receipt.blockHash)&&quantity(receipt.status)===1n,
          'Transaction failed or returned an invalid receipt. Stop and inspect the journal.');
        const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
        if(block!==null) {
          requireSafe(block?.hash===receipt.blockHash,'Receipt is no longer in the canonical chain.');
          const latest=await rpc('eth_getBlockByNumber',['latest',false]);
          if(latest!==null&&quantity(latest.number)>=quantity(receipt.blockNumber)+2n)return receipt;
        }
      }
    } catch(error) {if(!error.retryableRead)throw error;}
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

export async function main(args=process.argv.slice(2)) {
  const [command,planFile,specFile,approvedHash]=args;
  requireSafe(args.length===4&&command==='deploy'&&/^[0-9a-f]{64}$/.test(approvedHash||''),
    'Use deploy with the reviewed plan, spec and SHA256.');
  const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
  const spec=normalizeSpec(JSON.parse(fs.readFileSync(specFile,'utf8')));
  requireSafe(plan.planSha256===approvedHash,'Plan differs from reviewed release.');
  const {bundle}=verifyPlan(plan,undefined,spec);
  await verifyRehearsal(plan,spec);
  const location=walletLocation();
  secureDirectory(location.home,location.directory);
  const directory=path.join(location.home,'.orvia','deployments');
  const rpcDirectory=path.join(location.home,'.orvia','rpc');
  secureDirectory(location.home,directory);secureDirectory(location.home,rpcDirectory);
  const rpc=deploymentRpc(readPrivateFile(path.join(rpcDirectory,'robinhood-mainnet-alchemy.url')).trim());
  const journalFile=path.join(directory,approvedHash+'.json');
  const historyFile=path.join(directory,approvedHash+'.nonce3-replacement.json');
  const lockFile=path.join(directory,CHAIN_ID+'-'+spec.sender.toLowerCase()+'.lock');
  let lock;
  try {lock=fs.openSync(lockFile,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);}
  catch {throw new SafeError('Another deployment holds the sender lock.');}
  try {
    const journal=readDeploymentJournal(journalFile);
    validateMarketJournal(journal,plan,spec);
    requireSafe(journal.entries.length>=4,'This reviewed continuation requires the original four saved entries.');
    requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID),'Wrong chain.');
    for(const address of new Set([spec.sender,spec.operator]))
      requireSafe(await rpc('eth_getCode',[address,'pending'])==='0x','Owner and operator must remain EOAs.');
    // Observe the canonical saved prefix, including a companion-history winner.
    async function observedPrefix() {
      const history=fs.existsSync(historyFile)?readReplacementHistory(historyFile,plan,spec):null;
      let count=0;
      for(let i=0;i<journal.entries.length;i++) {
        const candidates=i===3&&history?[history.oldEntry,history.replacementEntry]:[journal.entries[i]];
        let found=0;
        for(const entry of candidates) {
          const receipt=await rpc('eth_getTransactionReceipt',[entry.transactionHash]);
          if(receipt){await confirmedReceipt(entry.transactionHash,rpc);found++;}
        }
        requireSafe(found<=1,'Both nonce-3 histories claim canonical receipts.');
        if(!found)break;
        count++;
      }
      return count;
    }
    let confirmedPrefix=await observedPrefix();
    requireSafe(confirmedPrefix>=3,'Original first three confirmations are required.');
    try {await verifyDeployedPrefix(plan,confirmedPrefix,rpc,bundle);}
    catch(error) {
      const advanced=await observedPrefix();
      if(advanced<=confirmedPrefix)throw error;
      confirmedPrefix=advanced;await verifyDeployedPrefix(plan,confirmedPrefix,rpc,bundle);
    }
    if(confirmedPrefix===33){journal.completed=true;saveJournal(journalFile,journal);console.log('All256 contracts were already confirmed.');return;}
    console.log('Reviewed recovery: at most one nonce-3 fee replacement, then remaining deployment calls.');
    console.log('Only gas price may change for nonce 3. Every chain, nonce, target, calldata and value remains fixed.');
    console.log('New signatures use fresh market fee plus25% inclusion margin; no historical gas-price cap.');
    await withHiddenSession(async()=>{
      let password=await hiddenPrompt('Local encrypted-wallet password (hidden): ');
      const wallet=await decryptVerified(readPrivateFile(location.file),password,spec.sender);password='';
      const winner=await resolveNonce3({journal,plan,spec,rpc,wallet,historyFile});
      journal.entries[3]={...winner.entry,receipt:winner.receipt};
      validateMarketJournal(journal,plan,spec);saveJournal(journalFile,journal);
      console.log('Canonical nonce-3 receipt selected: '+winner.receipt.transactionHash);
      for(let i=4;i<journal.entries.length;i++) {
        journal.entries[i].receipt=await reconcileSignedEntry(journal.entries[i],plan.transactions[i].transaction,spec.sender,rpc,
          ()=>verifyDeployedPrefix(plan,i,rpc,bundle));
        saveJournal(journalFile,journal);
      }
      await verifyDeployedPrefix(plan,journal.entries.length,rpc,bundle);
      for(let index=journal.entries.length;index<33;index++) {
        const intended=plan.transactions[index].transaction;
        requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID),'RPC chain changed.');
        requireSafe(quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']))===BigInt(intended.nonce),
          'Sender nonce changed; preserve journal.');
        const evidence=feeEvidence(await marketQuote(rpc),'new_nonce');
        const price=decimal(evidence.chosenPriceWei);
        const {chainId,...estimateInput}=intended;
        const gas=quantity(await rpc('eth_estimateGas',[{...estimateInput,gasPrice:toQuantity(price)},'pending']));
        const limit=(gas*125n+99n)/100n;
        const block=await rpc('eth_getBlockByNumber',['latest',false]);
        requireSafe(gas>21000n&&limit<=quantity(block.gasLimit),'Gas estimate exceeds current block limits.');
        requireSafe(limit<=decimal(journal.initialQuote.estimates[index].gasIncludingL1Data)*2n,
          'Gas limit exceeds the original execution guard.');
        requireSafe(quantity(await rpc('eth_getBalance',[spec.sender,'pending']))>=limit*price,
          'Balance does not cover this live-market transaction.');
        const raw=await wallet.signTransaction({type:0,chainId:CHAIN_ID,nonce:Number(BigInt(intended.nonce)),
          to:intended.to||null,value:0n,data:intended.data,gasLimit:limit,gasPrice:price});
        const entry={index,transactionHash:keccak256(raw),rawTransaction:raw,gasLimit:limit.toString(),
          gasPriceWei:price.toString(),feeEvidence:evidence,signedAtUtc:new Date().toISOString()};
        validateSignedEntry(entry,intended,spec.sender);
        journal.entries.push(entry);validateMarketJournal(journal,plan,spec);saveJournal(journalFile,journal);
        requireSafe(quantity(await rpc('eth_chainId'))===BigInt(CHAIN_ID)
          &&quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']))===BigInt(intended.nonce),
          'Chain or nonce changed after signature; saved transaction retained.');
        requireSafe(await rpc('eth_sendRawTransaction',[raw])===entry.transactionHash,'Broadcast hash differs.');
        entry.receipt=await confirmedReceipt(entry.transactionHash,rpc);saveJournal(journalFile,journal);
        console.log('Confirmed '+(index+1)+'/33: '+entry.transactionHash);
      }
    });
    const verified=await verifyDeployedPrefix(plan,33,rpc,bundle);
    journal.completed=verified.complete;journal.completedAtUtc=new Date().toISOString();
    validateMarketJournal(journal,plan,spec);saveJournal(journalFile,journal);
    console.log('All256 contract runtimes and registrations verified.');
  } finally {fs.closeSync(lock);fs.unlinkSync(lockFile);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error instanceof SafeError?error.message:'Market recovery stopped; retain private journal and history.');process.exitCode=2;});
