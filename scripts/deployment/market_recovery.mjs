// Explicit one-time nonce-3 replacement policy. No wallet unlock or automatic rebid.
import fs from 'node:fs';
import path from 'node:path';
import {Transaction,keccak256,getAddress} from 'ethers';
import {readDeploymentJournal,validateJournal,validateSignedEntry} from './hybrid_operator.mjs';
import {SafeError} from '../../experimental/mainnet-lite/local_wallet.mjs';

export const ORIGINAL_NONCE3_HASH='0xf8f37c49df70ba6581b2620a47558c5b505139afe27a0b299f591abc7f09515b';
const must=(ok,message)=>{if(!ok)throw new SafeError(message);};
const decimal=x=>{must(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x),'Invalid market quantity.');return BigInt(x);};
const quantity=x=>{must(typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x),'Invalid RPC quantity.');return BigInt(x);};
const isHash=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
const max=(a,b)=>a>b?a:b;
export const replacementPrice=(oldPrice,currentMarket)=>{must(oldPrice>0n&&currentMarket>0n,'Positive market prices required.');return(max(oldPrice,currentMarket)*125n+99n)/100n;};

export async function marketQuote(rpc) {
  const observed=quantity(await rpc('eth_gasPrice'));
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  must(observed>0n&&isHash(block?.hash),'Invalid fresh market quote.');
  const base=quantity(block.baseFeePerGas);
  return {observedPriceWei:observed.toString(),baseFeeWei:base.toString(),marketPriceWei:max(observed,base).toString(),blockNumber:block.number,blockHash:block.hash,observedAtUtc:new Date().toISOString()};
}
export function feeEvidence(quote,kind,oldPrice) {
  const market=decimal(quote.marketPriceWei);
  const chosen=kind==='nonce3_replacement'?replacementPrice(oldPrice,market):(market*125n+99n)/100n;
  return {schema:'orvia.live-market-fee.v1',kind,...quote,chosenPriceWei:chosen.toString(),inclusionMarginPercent:25,...(oldPrice?{oldPriceWei:oldPrice.toString()}:{} )};
}
function validateEvidence(e,tx,index) {
  must(e?.schema==='orvia.live-market-fee.v1'&&e.inclusionMarginPercent===25&&isHash(e.blockHash),'Missing live-market fee evidence.');
  const market=max(decimal(e.observedPriceWei),decimal(e.baseFeeWei));
  must(market===decimal(e.marketPriceWei)&&tx.gasPrice===decimal(e.chosenPriceWei),'Signed market fee differs from evidence.');
  quantity(e.blockNumber);must(typeof e.observedAtUtc==='string'&&Number.isFinite(Date.parse(e.observedAtUtc)),'Invalid market quote time.');
  if(e.kind==='nonce3_replacement')must(index===3&&tx.gasPrice===replacementPrice(decimal(e.oldPriceWei),market),'Invalid one-time replacement price.');
  else must(e.kind==='new_nonce'&&tx.gasPrice===(market*125n+99n)/100n,'Invalid first-signature market margin.');
}
export function validateMarketJournal(journal,plan,spec) {
  // Reuse original immutable quote/plan/schema checks without its historical price cap.
  must(typeof journal.completed==='boolean','Invalid journal completion flag.');
  const reference=validateJournal({...journal,entries:[],completed:false},plan,spec);
  must(Array.isArray(journal.entries)&&journal.entries.length<=33,'Invalid market journal entries.');
  for(let i=0;i<journal.entries.length;i++) {
    const entry=journal.entries[i];must(entry.index===i,'Journal ordering changed.');
    const tx=validateSignedEntry(entry,plan.transactions[i].transaction,spec.sender);
    must(tx.gasLimit<=decimal(journal.initialQuote.estimates[i].gasIncludingL1Data)*2n,'Signed gas limit exceeds original guard.');
    if(entry.feeEvidence)validateEvidence(entry.feeEvidence,tx,i);
    else must(tx.gasPrice<=reference.maxGasPrice,'Historical signature exceeds its original price guard.');
  }
  must(!journal.completed||journal.entries.length===33,'Incomplete journal marked complete.');
  return true;
}
export function writeHistoryExclusive(file,history) {
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,JSON.stringify(history,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
function validateHistory(history,plan,spec,expectedOldHash=ORIGINAL_NONCE3_HASH) {
  must(history?.schema==='orvia.nonce3-replacement-history.v1'&&history.planSha256===plan.planSha256&&history.sender===spec.sender&&history.nonce===3,'Replacement history belongs to another run.');
  must(history.oldEntry?.transactionHash===expectedOldHash,'Unexpected original nonce-3 signature.');
  const old=validateSignedEntry(history.oldEntry,plan.transactions[3].transaction,spec.sender);
  const next=validateSignedEntry(history.replacementEntry,plan.transactions[3].transaction,spec.sender);
  must(next.gasLimit===old.gasLimit&&next.gasPrice>old.gasPrice,'Replacement may change only the gas price.');
  validateEvidence(history.replacementEntry.feeEvidence,next,3);
  must(decimal(history.replacementEntry.feeEvidence.oldPriceWei)===old.gasPrice,'Replacement old price differs from saved signature.');
  return history;
}

export function readReplacementHistory(file,plan,spec){return validateHistory(readDeploymentJournal(file),plan,spec);}

export async function resolveNonce3(options) {
  must(options.oldHash===undefined||options.oldHash===ORIGINAL_NONCE3_HASH,'Only the reviewed nonce-3 replacement is allowed.');
  return resolveReviewedNonce3({...options,oldHash:ORIGINAL_NONCE3_HASH});
}
// Core is exported for independent synthetic-key race tests; production uses the pinned wrapper above.
export async function resolveReviewedNonce3({journal,plan,spec,rpc,wallet,historyFile,saveHistory=writeHistoryExclusive,oldHash,timeoutMs=600000,wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
  must(isHash(oldHash),'Reviewed old transaction hash required.');
  const current=journal.entries[3];must(current&&current.index===3,'Saved nonce-3 entry missing.');
  let history=fs.existsSync(historyFile)?validateHistory(readDeploymentJournal(historyFile),plan,spec,oldHash):null;
  const original=history?.oldEntry??current;
  must(original.transactionHash===oldHash,'Original saved nonce-3 identity changed.');
  validateSignedEntry(original,plan.transactions[3].transaction,spec.sender);
  const deadline=Date.now()+timeoutMs;
  async function observe(entries) {
    const found=[];let seenReceipt=false;
    for(const entry of entries) {
      const receipt=await rpc('eth_getTransactionReceipt',[entry.transactionHash]);
      if(!receipt)continue;seenReceipt=true;
      must(receipt.transactionHash===entry.transactionHash&&quantity(receipt.status)===1n&&isHash(receipt.blockHash),'Nonce-3 receipt failed or is malformed.');
      const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
      if(block===null)continue;
      must(block?.hash===receipt.blockHash,'Nonce-3 receipt conflicts with canonical block.');
      found.push({entry,receipt});
    }
    must(found.length<=1,'Both nonce-3 signatures claim canonical receipts; stop for review.');
    if(found.length) {
      const latest=await rpc('eth_getBlockByNumber',['latest',false]);
      if(latest&&quantity(latest.number)>=quantity(found[0].receipt.blockNumber)+2n)return {seen:true,winner:found[0]};
      return {seen:true,winner:null};
    }
    return {seen:seenReceipt,winner:null};
  }
  async function poll(entries) {
    while(Date.now()<deadline) {
      try {
        const state=await observe(entries);if(state.winner)return state.winner;
        const latest=quantity(await rpc('eth_getTransactionCount',[spec.sender,'latest']));
        must(latest>=3n&&latest<=4n,'Nonce changed beyond the reviewed recovery.');
      }catch(error){if(!error.retryableRead)throw error;}
      await wait(2000);
    }
    throw new SafeError('No canonical nonce-3 winner selected; preserve both signatures and the journal.');
  }
  const initial=await observe(history?[history.oldEntry,history.replacementEntry]:[original]);
  if(initial.winner)return initial.winner;
  if(initial.seen)return poll(history?[history.oldEntry,history.replacementEntry]:[original]);
  must(quantity(await rpc('eth_chainId'))===4663n,'RPC chain changed.');
  const firstNonce=quantity(await rpc('eth_getTransactionCount',[spec.sender,'latest']));
  if(firstNonce===4n)return poll(history?[history.oldEntry,history.replacementEntry]:[original]);
  must(firstNonce===3n,'Nonce changed beyond reviewed recovery.');
  const pending=quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']));must(pending===3n||pending===4n,'Unexpected pending nonce.');
  if(pending===4n) {
    let identified=false;
    for(const entry of history?[history.oldEntry,history.replacementEntry]:[original]) {
      const known=await rpc('eth_getTransactionByHash',[entry.transactionHash]);
      if(known){must(known.hash===entry.transactionHash&&getAddress(known.from)===spec.sender&&quantity(known.nonce)===3n,'Known pending transaction identity mismatch.');identified=true;}
    }
    must(identified,'Pending nonce is occupied by an unidentified transaction.');
  }
  if(!history) {
    const old=Transaction.from(original.rawTransaction),quote=await marketQuote(rpc),evidence=feeEvidence(quote,'nonce3_replacement',old.gasPrice);
    const {chainId,...estimate}=plan.transactions[3].transaction;
    const gas=quantity(await rpc('eth_estimateGas',[estimate,'pending']));
    must(gas>21000n&&gas<=old.gasLimit,'Saved gas limit no longer covers the same call.');
    must(quantity(await rpc('eth_getBalance',[spec.sender,'pending']))>=old.gasLimit*decimal(evidence.chosenPriceWei),'Insufficient balance for reviewed replacement.');
    const raw=await wallet.signTransaction({type:0,chainId:4663,nonce:3,to:old.to,value:0n,data:old.data,gasLimit:old.gasLimit,gasPrice:decimal(evidence.chosenPriceWei)});
    const next={index:3,rawTransaction:raw,transactionHash:keccak256(raw),gasLimit:old.gasLimit.toString(),gasPriceWei:evidence.chosenPriceWei,feeEvidence:evidence,signedAtUtc:new Date().toISOString()};
    history=validateHistory({schema:'orvia.nonce3-replacement-history.v1',planSha256:plan.planSha256,sender:spec.sender,nonce:3,oldEntry:original,replacementEntry:next,createdAtUtc:new Date().toISOString()},plan,spec,oldHash);
    await saveHistory(historyFile,history); // Persist BOTH signed byte strings before any network send.
  }
  const afterSign=await observe([history.oldEntry,history.replacementEntry]);
  if(afterSign.winner)return afterSign.winner;
  if(afterSign.seen)return poll([history.oldEntry,history.replacementEntry]);
  must(quantity(await rpc('eth_chainId'))===4663n,'Chain changed after replacement signature.');
  const afterNonce=quantity(await rpc('eth_getTransactionCount',[spec.sender,'latest']));
  if(afterNonce===4n)return poll([history.oldEntry,history.replacementEntry]);
  must(afterNonce===3n,'Nonce changed beyond reviewed replacement.');
  const known=await rpc('eth_getTransactionByHash',[history.replacementEntry.transactionHash]);
  if(known)must(known.hash===history.replacementEntry.transactionHash&&getAddress(known.from)===spec.sender&&quantity(known.nonce)===3n,'Known replacement identity mismatch.');
  if(!known) {
    const parsed=Transaction.from(history.replacementEntry.rawTransaction);
    const block=await rpc('eth_getBlockByNumber',['latest',false]);
    must(parsed.gasLimit<=quantity(block.gasLimit),'Replacement gas exceeds current block limit.');
    must(quantity(await rpc('eth_getBalance',[spec.sender,'pending']))>=parsed.gasLimit*parsed.gasPrice,'Balance no longer covers saved replacement.');
    const {chainId,...input}=plan.transactions[3].transaction;
    const estimated=quantity(await rpc('eth_estimateGas',[input,'pending']));
    must(estimated>21000n&&estimated<=parsed.gasLimit,'Saved replacement gas is no longer sufficient.');
    const beforeSendNonce=quantity(await rpc('eth_getTransactionCount',[spec.sender,'latest']));
    if(beforeSendNonce===4n)return poll([history.oldEntry,history.replacementEntry]);
    must(beforeSendNonce===3n&&quantity(await rpc('eth_chainId'))===4663n,'Chain or nonce changed before replacement send.');
    const pendingNow=quantity(await rpc('eth_getTransactionCount',[spec.sender,'pending']));
    must(pendingNow===3n||pendingNow===4n,'Unexpected pending nonce before replacement send.');
    if(pendingNow===4n) {
      let identified=false;
      for(const entry of [history.oldEntry,history.replacementEntry]) {
        const transaction=await rpc('eth_getTransactionByHash',[entry.transactionHash]);
        if(transaction){must(transaction.hash===entry.transactionHash&&getAddress(transaction.from)===spec.sender&&quantity(transaction.nonce)===3n,'Pending transaction identity changed.');identified=true;}
      }
      must(identified,'Pending nonce was occupied by an unidentified transaction.');
    }
    let sent,sendRejected=false;
    try {sent=await rpc('eth_sendRawTransaction',[history.replacementEntry.rawTransaction]);}
    catch(error){sendRejected=true;
      // A nonce-consumed/already-known response may race the OLD transaction mining.
      // Never resend or sign again here: select one canonical old/new receipt below.
    }
    if(!sendRejected)must(sent===history.replacementEntry.transactionHash,'Replacement RPC hash mismatch.');
  }
  return poll([history.oldEntry,history.replacementEntry]);
}
