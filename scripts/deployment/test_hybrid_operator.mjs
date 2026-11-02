// Ephemeral test wallet and mocked RPC only. Never reads the user's wallet/RPC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {before, test} from 'node:test';
import {Interface, Wallet, getAddress, keccak256, toBeHex, toQuantity} from 'ethers';
import {CHAIN_ID} from './hybrid256.mjs';
import {confirmedReceipt, readDeploymentJournal, reconcileSignedEntry,
  validateJournal, validateSignedEntry, verifyDeployedPrefix} from './hybrid_operator.mjs';

const wallet = Wallet.createRandom(); // Test-only key remains in process memory.
const sender = wallet.address;
const spec = {chainId:CHAIN_ID,sender,owner:sender,operator:sender,firstNonce:'0'};
const plan = {planSha256:'a'.repeat(64),transactions:Array.from({length:33},(_,index)=>({
  kind:index?'create_shards':'create_coordinator',transaction:{chainId:CHAIN_ID,from:sender,
    nonce:toQuantity(index),value:'0x0',data:'0x60006000',...(index?{to:sender}:{})}}))};
const clone = value => structuredClone(value);
let entry;
async function signed(overrides={}) {
  const raw = await wallet.signTransaction({type:0,chainId:CHAIN_ID,nonce:0,value:0n,data:'0x60006000',
    gasLimit:125000n,gasPrice:10n,...overrides});
  return {index:0,rawTransaction:raw,transactionHash:keccak256(raw),gasLimit:'125000',gasPriceWei:'10'};
}
function journal() {
  return {schema:'orvia.hybrid256.deployment.v1',planSha256:plan.planSha256,spec,entries:[clone(entry)],completed:false,
    initialQuote:{schema:'orvia.hybrid256.quote.v1',planSha256:plan.planSha256,chainId:CHAIN_ID,sender,nonce:'0x0',
      actualContracts:256,infrastructureTransactions:33,publicTransactionsSent:0,conditional:true,fullCampaignTotalWei:null,
      referenceBlock:{number:'0x1',hash:'0x'+'1'.repeat(64)},balanceWei:'1000000000',gasPriceWei:'10',
      totalInfrastructureGasIncludingL1Data:'3300000',totalInfrastructureFeeWei:'33000000',
      estimates:plan.transactions.map((t,index)=>({index,kind:t.kind,gasIncludingL1Data:'100000',
        feeWeiAtObservedPrice:'1000000',usesLocalPredecessorStateOverrides:index>0}))}};
}
before(async()=>{entry=await signed();});

test('validates signed intent and rejects substitutions without displaying raw data',async()=>{
  validateSignedEntry(entry,plan.transactions[0].transaction,sender);
  for(const change of [{chainId:1},{nonce:1},{value:1n},{data:'0x6001'},{to:sender},{type:2,maxFeePerGas:10n,maxPriorityFeePerGas:1n,gasPrice:undefined}]) {
    assert.throws(()=>validateSignedEntry({...entry,rawTransaction:''},plan.transactions[0].transaction,sender));
    const altered=await signed(change);
    assert.throws(()=>validateSignedEntry(altered,plan.transactions[0].transaction,sender));
  }
  assert.throws(()=>validateSignedEntry({...entry,gasPriceWei:'11'},plan.transactions[0].transaction,sender));
});

test('validates journal binding, totals, entry ordering, completion and fee guards',async()=>{
  assert.equal(validateJournal(journal(),plan,spec).maxGasPrice,20n);
  for(const mutate of [j=>j.planSha256='b'.repeat(64),j=>j.initialQuote.sender='0x'+'1'.repeat(40),
    j=>j.initialQuote.gasPriceWei='100',j=>j.initialQuote.estimates[1].gasIncludingL1Data='100001',
    j=>j.initialQuote.totalInfrastructureFeeWei='1',j=>j.entries[0].index=1,j=>j.completed=true,
    j=>j.initialQuote.referenceBlock.number='0x00']) {
    const j=journal();mutate(j);assert.throws(()=>validateJournal(j,plan,spec));
  }
  const high=journal();high.entries[0]=await signed({gasPrice:21n});high.entries[0].gasPriceWei='21';
  assert.throws(()=>validateJournal(high,plan,spec),/quote guards/);
  const gas=journal();gas.entries[0]=await signed({gasLimit:200001n});gas.entries[0].gasLimit='200001';
  assert.throws(()=>validateJournal(gas,plan,spec),/quote guards/);
});

function mock(options={}) {
  const calls=[];let sent=false,receiptReads=0;
  const receipt={transactionHash:entry.transactionHash,status:'0x1',blockNumber:'0x10',blockHash:'0x'+'1'.repeat(64)};
  return {calls,rpc:async(method,params=[])=>{
    calls.push({method,params});
    switch(method) {
      case 'eth_chainId':return options.chain??toQuantity(CHAIN_ID);
      case 'eth_getTransactionReceipt':return options.existingReceipt||sent||(++receiptReads>1&&options.confirmAfterLookup)?{...receipt,...options.receipt}:null;
      case 'eth_getTransactionByHash':return options.known?{hash:entry.transactionHash,from:sender,nonce:'0x0'}:null;
      case 'eth_getTransactionCount':return options.nonce??'0x0';
      case 'eth_getBalance':return options.balance??'0x10000000';
      case 'eth_getCode':return options.code??'0x';
      case 'eth_estimateGas':return options.gas??toQuantity(100000);
      case 'eth_getBlockByNumber':return {number:'0x12',hash:options.blockHash??receipt.blockHash,gasLimit:toQuantity(30000000)};
      case 'eth_sendRawTransaction':
        assert.deepEqual(params,[entry.rawTransaction]);sent=true;return entry.transactionHash;
      default:throw new Error('Unexpected mock RPC '+method);
    }
  }};
}

test('recovers a crash before send using only identical signed bytes after fresh checks',async()=>{
  const {rpc,calls}=mock();let prefixChecks=0;
  const result=await reconcileSignedEntry(entry,plan.transactions[0].transaction,sender,rpc,async()=>prefixChecks++);
  assert.equal(result.transactionHash,entry.transactionHash);
  assert.equal(prefixChecks,1);
  assert.equal(calls.filter(c=>c.method==='eth_sendRawTransaction').length,1);
  assert.deepEqual(calls.filter(c=>c.method==='eth_getTransactionCount').map(c=>c.params[1]),['latest','pending','pending']);
});

test('does not retransmit an already confirmed journal transaction',async()=>{
  const {rpc,calls}=mock({existingReceipt:true});
  await reconcileSignedEntry(entry,plan.transactions[0].transaction,sender,rpc);
  assert(!calls.some(c=>c.method==='eth_sendRawTransaction'));
});

test('waits for a known pending transaction without rebroadcasting',async()=>{
  const {rpc,calls}=mock({known:true,confirmAfterLookup:true});
  await reconcileSignedEntry(entry,plan.transactions[0].transaction,sender,rpc);
  assert(calls.some(c=>c.method==='eth_getTransactionByHash'));
  assert(!calls.some(c=>c.method==='eth_sendRawTransaction'));
});

test('refuses retransmission for changed chain, consumed nonce, low balance, or insufficient gas',async()=>{
  for(const options of [{chain:'0x1'},{nonce:'0x1'},{balance:'0x0'},{gas:toQuantity(125001)},{gas:'0x0'},{code:'0x6000'}]) {
    const {rpc,calls}=mock(options);
    await assert.rejects(reconcileSignedEntry(entry,plan.transactions[0].transaction,sender,rpc));
    assert(!calls.some(c=>c.method==='eth_sendRawTransaction'));
  }
  const {rpc,calls}=mock();
  await assert.rejects(reconcileSignedEntry(entry,plan.transactions[0].transaction,sender,rpc,
    async()=>{throw new Error('prefix mismatch');}),/prefix mismatch/);
  assert(!calls.some(c=>c.method==='eth_sendRawTransaction'));
});

test('rejects reverted, reorged, and timed-out receipts',async()=>{
  await assert.rejects(confirmedReceipt(entry.transactionHash,mock({existingReceipt:true,receipt:{status:'0x0'}}).rpc));
  await assert.rejects(confirmedReceipt(entry.transactionHash,mock({existingReceipt:true,blockHash:'0x'+'2'.repeat(64)}).rpc));
  await assert.rejects(confirmedReceipt(entry.transactionHash,mock().rpc,0),/timed out/);
});

test('journal reader rejects unsafe permissions, hardlinks, and symlinks',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-operator-test-'));
  try {
    const file=path.join(temp,'journal.json');fs.writeFileSync(file,JSON.stringify(journal()),{mode:0o600});
    assert.equal(readDeploymentJournal(file).planSha256,plan.planSha256);
    fs.chmodSync(file,0o644);assert.throws(()=>readDeploymentJournal(file));fs.chmodSync(file,0o600);
    const link=path.join(temp,'link.json');fs.linkSync(file,link);assert.throws(()=>readDeploymentJournal(file));fs.unlinkSync(link);
    fs.symlinkSync(file,link);assert.throws(()=>readDeploymentJournal(link));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test('prefix verification pins one block and rejects code, nonce, and reorg changes',async()=>{
  const abi=['function owner() view returns(address)','function operator() view returns(address)',
    'function shardCount() view returns(uint16)'];
  const iface=new Interface(abi),hash='0x'+'1'.repeat(64);
  const p={spec,coordinator:sender,contracts:Array.from({length:256},(_,i)=>({
    address:i?getAddress(toBeHex(i,20)):sender,runtime:'0x6000'}))};
  const b={artifacts:{ORVIAHybridCoordinator:{abi}}};
  const make=(change={})=>async(method,params)=>{
    if(method==='eth_getBlockByNumber')return {number:'0x20',hash:params[0]==='latest'?hash:(change.reorg??hash)};
    assert.equal(params.at(-1),'0x20');
    if(method==='eth_getCode')return params[0]===sender?(change.code??'0x6000'):'0x';
    if(method==='eth_getTransactionCount')return change.nonce??'0x0';
    if(method==='eth_call'){
      const name=iface.parseTransaction({data:params[0].data}).name;
      return iface.encodeFunctionResult(name,[name==='shardCount'?0:sender]);
    }
    throw new Error('Unexpected RPC');
  };
  assert.deepEqual(await verifyDeployedPrefix(p,1,make(),b),{verifiedContracts:1,complete:false});
  for(const change of [{code:'0x6001'},{nonce:'0x1'},{reorg:'0x'+'2'.repeat(64)}])
    await assert.rejects(verifyDeployedPrefix(p,1,make(change),b));
  const base=make();let gettersStarted=false;
  await assert.rejects(verifyDeployedPrefix(p,1,async(method,params)=>{
    if(method==='eth_call')gettersStarted=true;
    if(method==='eth_getBlockByNumber'&&params[0]!=='latest'&&gettersStarted)
      return {number:'0x20',hash:'0x'+'3'.repeat(64)};
    return base(method,params);
  },b),/block changed/);
});
