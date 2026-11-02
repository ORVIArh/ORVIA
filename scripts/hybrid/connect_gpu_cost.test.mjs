import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface,id,keccak256} from 'ethers';
import {compileHybrid} from '../deployment/hybrid256.mjs';
import {measureConnection} from './connect_gpu_cost.mjs';
const bundle=compileHybrid(),coder=AbiCoder.defaultAbiCoder();
const runForLane=target=>{for(let i=0;i<10000;i++){const r=id('Public local conditional gas run '+target+' '+i);if(Number(BigInt(keccak256(coder.encode(['bytes32'],[r])))%255n)===target)return r;}throw Error('No synthetic run');};
function context(lane){return{bundle,api:new Interface(bundle.artifacts.ORVIAHybridCoordinator.abi),plan:{runId:runForLane(lane),coordinator:'0x'+'12'.repeat(20)},spec:{sender:'0x'+'34'.repeat(20),owner:'0x'+'34'.repeat(20),operator:'0x'+'34'.repeat(20)},assessment:{diagnosticOnly:true,configuration:{protocolHash:id('protocol'),modelHash:id('model'),inputHash:id('input'),softwareHash:id('software'),environmentHash:id('environment'),requiredChecks:7,allowedChecks:7,diagnosticOnly:true},experimentId:id('local cost experiment'),runConfigHash:id('run config'),checkpointHash:id('checkpoint'),resultHash:id('result'),completedSteps:'6',checks:7,outcome:1,counterUnit:'numerical comparisons'}};}
for(const lane of[0,254])test('real three-receipt lifecycle with one authenticated shard at lane '+lane,async()=>{
 const c=context(lane),before=structuredClone({plan:c.plan,spec:c.spec,assessment:c.assessment});
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('No HTTP is allowed in local gas measurement');};
 let r;try{r=await measureConnection(c);}finally{globalThis.fetch=original;}
 assert.deepEqual({plan:c.plan,spec:c.spec,assessment:c.assessment},before);
 assert.equal(r.conditionalLocal,true);assert.equal(r.localFixtureReadinessInjected,true);assert.equal(r.unusedShardsOmitted,254);assert.equal(r.fixture.actualContracts,2);assert.equal(r.fixture.runLane,lane);assert.equal(r.publicTransactionsSent,0);assert.equal(r.usedProductionWallet,false);
 assert.deepEqual(r.receipts.map(x=>x.name),['registerExperiment','startRun','submitReport']);
 assert(r.receipts.every(x=>x.status===1&&BigInt(x.gasUsed)>21000n));
 assert.equal(r.totalGas,r.receipts.reduce((sum,x)=>sum+BigInt(x.gasUsed),0n).toString());
 assert.deepEqual(r.gas,Object.fromEntries(r.receipts.map(x=>[x.name,x.gasUsed])));
 assert.equal(r.sources.compilerBinding.standardInputSha256,bundle.binding.standardInputSha256);
 console.log(JSON.stringify({conditionalOnly:true,lane,gas:r.gas,totalGas:r.totalGas}));
});
test('non-diagnostic assessments and altered readiness layout fail closed',async()=>{
 let c=context(0);c.assessment.diagnosticOnly=false;await assert.rejects(measureConnection(c),/explicitly diagnostic/);
 c=context(0);c.assessment.configuration.diagnosticOnly=false;await assert.rejects(measureConnection(c),/explicitly diagnostic/);
 c=context(0);c.bundle=structuredClone(bundle);c.bundle.artifacts.ORVIAHybridCoordinator.storageLayout.storage.find(x=>x.label==='shardCount').offset=1;await assert.rejects(measureConnection(c),/storage layout/);
 c=context(0);c.plan.runId='0x'+'00'.repeat(32);await assert.rejects(measureConnection(c),/run ID/);
});
