// Independent synthetic-journal tests. No RPC, wallet file, HTTP or main invocation.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Wallet,Interface,id,keccak256,toQuantity} from 'ethers';
import {compileHybrid} from '../deployment/hybrid256.mjs';
import {expectedIdentities} from './report_operator.mjs';
import {domain,REPORT_TYPES,normalizeReport,reportDigest} from './attestation.mjs';
import {validateConnectionJournal,connectionActualFee,connectionProgress,registrationCalldata} from './connect_gpu.mjs';
const ZERO='0x'+'00'.repeat(32),COORD='0x3B188B4c5B76b009d80455D3bbB7597983E390f0';
const wallet=new Wallet(id('ORVIA independent connection journal tests DO NOT FUND'));
const bundle=compileHybrid(),api=new Interface(bundle.artifacts.ORVIAHybridCoordinator.abi);
const assessment={diagnosticOnly:true,configuration:{protocolHash:id('test protocol'),modelHash:id('test model'),inputHash:id('test input'),softwareHash:id('test software'),environmentHash:id('test env'),requiredChecks:7,allowedChecks:7,diagnosticOnly:true},experimentId:id('test experiment'),runConfigHash:id('test runconfig'),checkpointHash:id('test checkpoint'),resultHash:id('test result'),completedSteps:'6',checks:7,outcome:1};
const plan={planSha256:'a'.repeat(64),operationPlanSha256:'b'.repeat(64),coordinator:COORD,runId:id('test run'),chainId:4663,diagnosticOnly:true};
const context={assessment,bundle,api,plan:{...plan,planSha256:plan.operationPlanSha256},spec:{sender:wallet.address,owner:wallet.address,operator:wallet.address}};
const plain=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
async function journal(){
 const j={schema:'orvia.gpu-connection-journal.v1',planSha256:plan.planSha256,operationPlanSha256:plan.operationPlanSha256,chainId:4663,coordinator:COORD,runId:plan.runId,sender:wallet.address,actions:{},signedReport:null,complete:false};
 const report=normalizeReport({runId:plan.runId,configurationHash:expectedIdentities(context).runHash,sequence:1,completedSteps:6,previousCheckpointHash:assessment.checkpointHash,checkpointHash:assessment.checkpointHash,resultHash:assessment.resultHash,outcome:1,checks:7,validUntil:9999999999});
 j.signedReport={schema:'orvia.hybrid-signed-report.v1',operationPlanSha256:plan.operationPlanSha256,chainId:4663,coordinator:COORD,report:plain(report),digest:reportDigest(4663,COORD,report),signature:await wallet.signTypedData(domain(4663,COORD),REPORT_TYPES,report)};
 for(const [i,name]of ['registerExperiment','startRun','submitReport'].entries()){
  const data=name==='submitReport'?api.encodeFunctionData(name,[report,j.signedReport.signature]):registrationCalldata(context,name);
  const intended={from:wallet.address,to:COORD,value:'0x0',data,nonce:toQuantity(i+33)};
  const raw=await wallet.signTransaction({type:0,chainId:4663,nonce:i+33,to:COORD,value:0n,data,gasLimit:125000n,gasPrice:25n});
  const entry={rawTransaction:raw,transactionHash:keccak256(raw),gasLimit:'125000',gasPriceWei:'25',feeEvidence:{schema:'orvia.live-market-fee.v1',kind:'new_nonce',inclusionMarginPercent:25,observedPriceWei:'20',baseFeeWei:'20',marketPriceWei:'20',chosenPriceWei:'25',blockHash:id('synthetic fee block'),blockNumber:'0x64',observedAtUtc:'2026-11-02T00:00:00.000Z'}};
  j.actions[name]={intended,entry,receipt:{transactionHash:entry.transactionHash,status:'0x1',gasUsed:'0x10000',effectiveGasPrice:'0x14',blockHash:id('synthetic block '+i),blockNumber:toQuantity(i+100)}};
 }
 return j;
}
async function withFile(j,fn){const d=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-connect-journal-review-')),p=path.join(d,'journal.json');try{if(j)fs.writeFileSync(p,JSON.stringify(j),{mode:0o600});return await fn(p);}finally{fs.rmSync(d,{recursive:true,force:true});}}
test('registration calldata derives from exact reviewed assessment',()=>{
 assert.equal(registrationCalldata(context,'registerExperiment'),api.encodeFunctionData('registerExperiment',[assessment.experimentId,assessment.configuration]));
 assert.equal(registrationCalldata(context,'startRun'),api.encodeFunctionData('startRun',[assessment.experimentId,plan.runId,assessment.runConfigHash,assessment.checkpointHash]));
 assert.throws(()=>registrationCalldata(context,'other'));
});
test('valid saved journal resumes byte-for-byte and uses effective fee below signed cap',async()=>{
 const j=await journal();await withFile(j,p=>assert.deepEqual(validateConnectionJournal(p,plan,context),j));
 const fees=connectionActualFee(j);assert.equal(fees.count,3);assert.equal(fees.fee,3n*65536n*20n);
});
test('private journal substitutions fail before any signing or RPC',async()=>{
 const base=await journal();
 for(const mutate of [j=>j.planSha256='c'.repeat(64),j=>j.sender='0x'+'11'.repeat(20),j=>j.coordinator='0x'+'11'.repeat(20),j=>j.runId=id('wrongrun'),j=>j.chainId=1,j=>j.actions.extra={},j=>j.actions.startRun.intended.data='0x6001',j=>j.actions.registerExperiment.intended.from='0x'+'11'.repeat(20),j=>j.actions.startRun.intended.to='0x'+'11'.repeat(20),j=>j.actions.submitReport.entry.transactionHash=ZERO,j=>j.signedReport.report.resultHash=id('wrongresult')]){
  const j=structuredClone(base);mutate(j);await withFile(j,p=>assert.throws(()=>validateConnectionJournal(p,plan,context)));
 }
});
test('receipt status/hash/gas/charged-price corruption is rejected',async()=>{
 const base=await journal();
 for(const mutate of [r=>r.status='0x0',r=>r.transactionHash=ZERO,r=>r.gasUsed='0x1e849',r=>r.effectiveGasPrice='0x1a',r=>r.effectiveGasPrice='0x0']){
  const j=structuredClone(base);mutate(j.actions.submitReport.receipt);assert.throws(()=>connectionActualFee(j));
 }
});
test('public progress never exposes signed bytes or signatures, and totals exact confirmed fees',async()=>{
 const j=await journal(),p=connectionProgress(plan,'complete',j,{totalFeeEstimateEth:'0.0001',feeReserveEth:'0.001'});
 assert.equal(p.complete,true);assert.equal(p.confirmedTransactions,3);assert.equal(p.totalTransactions,3);assert.equal(p.totalActualFeeEth,'0.00000000000393216');assert.equal(p.diagnosticOnly,true);
 const bytes=JSON.stringify(p);for(const forbidden of ['rawTransaction','signature',j.signedReport.signature])assert(!bytes.includes(forbidden));
});
test('unsafe private journal file modes and symlinks are rejected',async()=>{
 const j=await journal();await withFile(j,p=>{fs.chmodSync(p,0o644);assert.throws(()=>validateConnectionJournal(p,plan,context));fs.chmodSync(p,0o600);const link=p+'.link';fs.symlinkSync(p,link);assert.throws(()=>validateConnectionJournal(link,plan,context));});
});
