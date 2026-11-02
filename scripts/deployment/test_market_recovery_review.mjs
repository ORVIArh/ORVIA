// Independent synthetic-key race review. No configured RPC, wallet file or main().
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Wallet,keccak256,toQuantity,Transaction} from 'ethers';
import {resolveReviewedNonce3,resolveNonce3,writeHistoryExclusive,replacementPrice,feeEvidence,marketQuote} from './market_recovery.mjs';
const BLOCK='0x'+'11'.repeat(32),OTHER='0x'+'22'.repeat(32);
async function fixture(o={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-market-review-')),wallet=Wallet.createRandom(),sender=wallet.address;
 const intended={chainId:4663,from:sender,nonce:'0x3',to:sender,value:'0x0',data:'0x60006000'};
 const raw=await wallet.signTransaction({type:0,chainId:4663,nonce:3,to:sender,value:0n,data:intended.data,gasLimit:125000n,gasPrice:10n});
 const old={index:3,rawTransaction:raw,transactionHash:keccak256(raw),gasLimit:'125000',gasPriceWei:'10'},plan={planSha256:'a'.repeat(64),transactions:Array.from({length:33},()=>({transaction:intended}))};
 const historyFile=path.join(dir,'history.json'),s={signs:0,sends:0,winner:null,pending:o.pending??3n,newEntry:null,nonce:null};
 const receipt=e=>({transactionHash:e.transactionHash,status:'0x1',blockHash:BLOCK,blockNumber:'0x64'});
 const rpc=async(m,p=[])=>{
  switch(m){
   case 'eth_chainId':return '0x1237';
   case 'eth_getTransactionReceipt':return s.winner==='old'&&p[0]===old.transactionHash?receipt(old):s.winner==='new'&&p[0]===s.newEntry?.transactionHash?receipt(s.newEntry):null;
   case 'eth_getBlockByNumber':return p[0]==='latest'?{number:'0x66',hash:BLOCK,baseFeePerGas:'0x14',gasLimit:'0x1c9c380'}:{number:'0x64',hash:BLOCK};
   case 'eth_getTransactionCount':return toQuantity(p[1]==='latest'?(s.nonce??(s.winner?4n:3n)):(s.winner?4n:s.pending));
   case 'eth_getTransactionByHash':return o.knownOld&&p[0]===old.transactionHash?{hash:old.transactionHash,from:sender,nonce:'0x3'}:null;
   case 'eth_gasPrice':return '0x14';case 'eth_estimateGas':return toQuantity(o.gas??100000n);case 'eth_getBalance':return toQuantity(o.balance??1000000000n);
   case 'eth_sendRawTransaction':{
    s.sends++;assert(fs.existsSync(historyFile));const h=JSON.parse(fs.readFileSync(historyFile));assert.equal(h.oldEntry.rawTransaction,raw);assert.equal(h.replacementEntry.rawTransaction,p[0]);s.newEntry=h.replacementEntry;
    if(o.onSend)return o.onSend(s,p[0]);s.winner='new';return keccak256(p[0]);
   }
   default:throw Error('Unexpected mocked method '+m);
  }
 };
 const signing={signTransaction:async tx=>{s.signs++;return wallet.signTransaction(o.badIntent?{...tx,data:'0x6001'}:tx);}};
 const save=async(file,h)=>{writeHistoryExclusive(file,h);s.newEntry=h.replacementEntry;if(o.onSave)await o.onSave(s,h);};
 const args={journal:{entries:[null,null,null,old]},plan,spec:{sender},rpc,wallet:signing,historyFile,oldHash:old.transactionHash,saveHistory:save,timeoutMs:1000,wait:async()=>{if(o.onWait)o.onWait(s);}};
 return {s,args,old,historyFile,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
async function using(o,fn){const f=await fixture(o);try{return await fn(f);}finally{f.cleanup();}}
test('durable both-signature history precedes a single send and canonical replacement winner',async()=>using({},async f=>{const r=await resolveReviewedNonce3(f.args);assert.equal(r.entry.transactionHash,f.s.newEntry.transactionHash);assert.equal(f.s.signs,1);assert.equal(f.s.sends,1);assert.equal(Transaction.from(r.entry.rawTransaction).gasPrice,25n);assert.equal(fs.statSync(f.historyFile).mode&0o777,0o600);}));
test('canonical old winner never signs or sends',async()=>using({},async f=>{f.s.winner='old';const r=await resolveReviewedNonce3(f.args);assert.equal(r.entry.transactionHash,f.old.transactionHash);assert.equal(f.s.signs,0);assert.equal(f.s.sends,0);}));
test('old winner after signing prevents broadcast',async()=>using({onSave:s=>s.winner='old'},async f=>{const r=await resolveReviewedNonce3(f.args);assert.equal(r.entry.transactionHash,f.old.transactionHash);assert.equal(f.s.signs,1);assert.equal(f.s.sends,0);}));
test('send rejection with old mining race selects old and never signs or sends twice',async()=>using({onSend:s=>{s.winner='old';throw Error('nonce consumed');}},async f=>{const r=await resolveReviewedNonce3(f.args);assert.equal(r.entry.transactionHash,f.old.transactionHash);assert.equal(f.s.signs,1);assert.equal(f.s.sends,1);}));
test('crash after durable history resumes same bytes without another signature',async()=>using({onSave:()=>{throw Error('stop after save');}},async f=>{await assert.rejects(resolveReviewedNonce3(f.args),/stop after save/);assert.equal(f.s.signs,1);const raw=JSON.parse(fs.readFileSync(f.historyFile)).replacementEntry.rawTransaction;const r=await resolveReviewedNonce3({...f.args,saveHistory:()=>assert.fail('history rewritten')});assert.equal(r.entry.rawTransaction,raw);assert.equal(f.s.signs,1);assert.equal(f.s.sends,1);}));
test('unknown pending nonce4 fails before signing',async()=>using({pending:4n},async f=>{await assert.rejects(resolveReviewedNonce3(f.args),/unidentified/);assert.equal(f.s.signs,0);assert.equal(f.s.sends,0);}));
test('identified pending original admits exactly one replacement',async()=>using({pending:4n,knownOld:true},async f=>{await resolveReviewedNonce3(f.args);assert.equal(f.s.signs,1);assert.equal(f.s.sends,1);}));
test('returned send hash mismatch remains fatal',async()=>using({onSend:()=>OTHER},async f=>{await assert.rejects(resolveReviewedNonce3(f.args),/RPC hash mismatch/);assert.equal(f.s.signs,1);assert.equal(f.s.sends,1);}));
test('nonce4 after signing polls both instead of sending',async()=>using({onSave:s=>s.nonce=4n,onWait:s=>s.winner='old'},async f=>{const r=await resolveReviewedNonce3(f.args);assert.equal(r.entry.transactionHash,f.old.transactionHash);assert.equal(f.s.signs,1);assert.equal(f.s.sends,0);}));
test('substituted signed intent never reaches disk or network',async()=>using({badIntent:true},async f=>{await assert.rejects(resolveReviewedNonce3(f.args),/differs from the reviewed deployment/);assert(!fs.existsSync(f.historyFile));assert.equal(f.s.sends,0);}));
test('low balance or insufficient saved gas fails before signature',async()=>{for(const o of[{balance:0n},{gas:125001n}])await using(o,async f=>{await assert.rejects(resolveReviewedNonce3(f.args));assert.equal(f.s.signs,0);assert.equal(f.s.sends,0);});});
test('production wrapper refuses an injected synthetic old hash',async()=>using({},async f=>{await assert.rejects(resolveNonce3(f.args),/Only the reviewed nonce-3/);assert.equal(f.s.signs,0);assert.equal(f.s.sends,0);}));
test('live base fee wins over observed price without historical ceiling',async()=>{const q=await marketQuote(async m=>m==='eth_gasPrice'?'0x14':{hash:BLOCK,number:'0x64',baseFeePerGas:'0x64'});assert.equal(feeEvidence(q,'new_nonce').chosenPriceWei,'125');assert.equal(replacementPrice(10n,100n),125n);});
