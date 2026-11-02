import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {formatEther} from '../../ORVIA/node_modules/ethers/lib.esm/index.js';
import {verifyPlan} from '../../ORVIA/scripts/deployment/hybrid256.mjs';
import {readDeploymentJournal, validateSignedEntry, verifyDeployedPrefix} from '../../ORVIA/scripts/deployment/hybrid_operator.mjs';

import {validateMarketJournal} from '../../ORVIA/scripts/deployment/market_recovery.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('../hybrid256-release/plan.json',import.meta.url)));
const spec = JSON.parse(fs.readFileSync(new URL('../hybrid256-release/spec.json',import.meta.url)));
if(plan.planSha256 !== '814e9c0aced4f8c6ef24bf4ca7fe5d423ef8bb4e4d54216a3dea02484958b50c') throw Error('Wrong plan');
const {bundle}=verifyPlan(plan,undefined,spec);
const journal=readDeploymentJournal(path.join(os.homedir(),'.orvia/deployments',plan.planSha256+'.json'));
validateMarketJournal(journal,plan,spec);
if(!journal.completed||journal.entries.length!==33) throw Error('Deployment not complete');
const url=fs.readFileSync(path.join(os.homedir(),'.orvia/rpc/robinhood-mainnet-alchemy.url'),'utf8').trim();
const permitted=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getTransactionCount','eth_call','eth_getTransactionReceipt','eth_getTransactionByHash']);
let serial=0;
const rpc=async(method,params=[])=>{
  if(!permitted.has(method)) throw Error('Read-only verification method rejected');
  const id=++serial;
  for(let attempt=0;attempt<3;attempt++){
    try {
      const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw Error('Read-only request failed');
      const data=await response.json();
      if(data.jsonrpc!=='2.0'||data.id!==id||data.error||!Object.hasOwn(data,'result')) throw Error('Read-only response invalid');
      return data.result;
    } catch {
      if(attempt===2) throw Error('Read-only verification unavailable: '+method);
      await new Promise(r=>setTimeout(r,1000*(attempt+1)));
    }
  }
};
if(BigInt(await rpc('eth_chainId'))!==4663n) throw Error('Wrong chain');
const pinned=await rpc('eth_getBlockByNumber',['latest',false]);
const fixedRpc=(method,params=[])=>rpc(method,method==='eth_getBlockByNumber'&&params[0]==='latest'?[pinned.number,false]:params);
const verified=await verifyDeployedPrefix(plan,33,fixedRpc,bundle);
const receipts=[];
let gas=0n,cost=0n;
for(let i=0;i<33;i++){
  const entry=journal.entries[i];
  const tx=validateSignedEntry(entry,plan.transactions[i].transaction,spec.sender);
  const receipt=await rpc('eth_getTransactionReceipt',[entry.transactionHash]);
  if(!receipt||BigInt(receipt.status)!==1n||receipt.transactionHash!==entry.transactionHash) throw Error('Receipt invalid');
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  if(block.hash!==receipt.blockHash) throw Error('Receipt not canonical');
  const used=BigInt(receipt.gasUsed),price=BigInt(receipt.effectiveGasPrice);
  if(used<=0n||used>tx.gasLimit||price<=0n||price>tx.gasPrice) throw Error('Receipt gas exceeds signed limits');
  const mined=await rpc('eth_getTransactionByHash',[entry.transactionHash]);
  if(!mined||mined.hash!==tx.hash||mined.blockHash!==receipt.blockHash
    ||BigInt(mined.blockNumber)!==BigInt(receipt.blockNumber)
    ||BigInt(mined.transactionIndex)!==BigInt(receipt.transactionIndex)
    ||mined.from.toLowerCase()!==tx.from.toLowerCase()
    ||(mined.to?.toLowerCase()??null)!==(tx.to?.toLowerCase()??null)
    ||BigInt(mined.chainId)!==4663n||BigInt(mined.nonce)!==BigInt(tx.nonce)
    ||BigInt(mined.gas)!==tx.gasLimit||BigInt(mined.value)!==tx.value
    ||mined.input!==tx.data||BigInt(mined.type)!==BigInt(tx.type))
    throw Error('Canonical mined transaction differs from signed intent');
  gas+=used; cost+=used*price;
  receipts.push({index:i,kind:plan.transactions[i].kind,transactionHash:entry.transactionHash,
    nonce:Number(tx.nonce),blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,
    status:1,gasUsed:used.toString(),effectiveGasPriceWei:price.toString(),signedGasPriceCapWei:tx.gasPrice.toString(),feeWei:(used*price).toString(),
    feeEth:formatEther(used*price),contractAddress:receipt.contractAddress});
}
let replacementHistory=null;
const historyFile=path.join(os.homedir(),'.orvia/deployments',plan.planSha256+'.nonce3-replacement.json');
if(fs.existsSync(historyFile)) {
  const history=readDeploymentJournal(historyFile);
  if(history.schema!=='orvia.nonce3-replacement-history.v1'||history.planSha256!==plan.planSha256
    ||history.sender!==spec.sender||history.nonce!==3) throw Error('Wrong replacement history');
  const original=validateSignedEntry(history.oldEntry,plan.transactions[3].transaction,spec.sender);
  const replacement=validateSignedEntry(history.replacementEntry,plan.transactions[3].transaction,spec.sender);
  if(original.hash!=='0xf8f37c49df70ba6581b2620a47558c5b505139afe27a0b299f591abc7f09515b'
    ||replacement.gasLimit!==original.gasLimit||replacement.gasPrice<=original.gasPrice)
    throw Error('Replacement differs from the reviewed fee-only change');
  const selected=journal.entries[3].transactionHash;
  if(selected!==original.hash&&selected!==replacement.hash)throw Error('Unknown nonce-3 winner');
  const other=selected===original.hash?replacement.hash:original.hash;
  const otherReceipt=await rpc('eth_getTransactionReceipt',[other]);
  if(otherReceipt) {
    const otherBlock=await rpc('eth_getBlockByNumber',[otherReceipt.blockNumber,false]);
    if(otherBlock?.hash===otherReceipt.blockHash)throw Error('Two canonical transactions claim nonce 3');
  }
  replacementHistory={originalHash:original.hash,replacementHash:replacement.hash,
    selectedHash:selected,onlyGasPriceChanged:true,canonicalTransactionsAtNonce3:1,
    privateHistorySha256:crypto.createHash('sha256').update(fs.readFileSync(historyFile)).digest('hex')};
}
const latest=await rpc('eth_getBlockByNumber',['latest',false]);
if(BigInt(latest.number)<BigInt(receipts.at(-1).blockNumber)+2n) throw Error('Confirmation depth insufficient');
if(receipts.some(r=>BigInt(r.blockNumber)>BigInt(pinned.number)-2n)) throw Error('Receipt insufficiently confirmed at pinned observation');
if((await rpc('eth_getBlockByNumber',[pinned.number,false])).hash!==pinned.hash) throw Error('Pinned observation changed');
const report={schema:'orvia.hybrid256.mainnet-verification.v1',observedAtUtc:new Date().toISOString(),chainId:4663,
  planSha256:plan.planSha256,coordinator:plan.coordinator,owner:spec.owner,operator:spec.operator,
  ...verified,transactions:33,totalGasUsed:gas.toString(),totalFeeWei:cost.toString(),totalFeeEth:formatEther(cost),
  latestBlockNumber:Number(BigInt(latest.number)),latestBlockHash:latest.hash,pinnedObservationBlock:Number(BigInt(pinned.number)),pinnedObservationHash:pinned.hash,
  feeAccounting:'Actual receipt gasUsed times effectiveGasPrice; positive charged price must not exceed signed legacy cap. Canonical mined transaction intent independently matched.',
  scope:'256-contract reporting infrastructure only; no scientific result accepted by this verification',
  scientificCampaignReady:false,replacementHistory,receipts,
  contracts:plan.contracts.map(c=>({address:c.address,runtimeKeccak256:c.runtimeKeccak256}))};
const target=new URL('./mainnet-market-verification.json',import.meta.url);
fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({complete:verified.complete,coordinator:report.coordinator,contracts:verified.verifiedContracts,transactions:33,totalFeeEth:report.totalFeeEth,totalGasUsed:report.totalGasUsed,reportSha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}));
