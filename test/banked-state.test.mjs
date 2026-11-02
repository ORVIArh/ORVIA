import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import solc from 'solc';
import ganache from 'ganache';
import {AbiCoder,BrowserProvider,Contract,ContractFactory,Interface,ZeroAddress,ZeroHash,
  encodeBytes32String,getCreate2Address,id,keccak256,toBeHex,zeroPadValue} from 'ethers';
import {quadFromNumber as q,qvec} from './helpers.mjs';

const gasLimit=12_000_000;
const integer=n=>toBeHex(n,32), word=n=>zeroPadValue(n,32);
const sha=value=>createHash('sha256').update(value).digest('hex');
const coder=AbiCoder.defaultAbiCoder();

function compileFixture(){
 const sources={};
 function add(file){
  if(sources[file])return;
  const content=fs.readFileSync(file,'utf8');sources[file]={content};
  for(const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1])));
 }
 for(const file of ['contracts/core/BankedWorkingState.sol','test/contracts/WorkingStateWriterHarness.sol','test/contracts/ShardedStateForceHarness.sol'])add(file);
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');
 const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}};
 const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings})));
 const errors=output.errors?.filter(e=>e.severity==='error')??[];
 assert.equal(errors.length,0,errors.map(e=>e.formattedMessage).join('\n'));
 const artifacts={};
 for(const[file,contracts]of Object.entries(output.contracts))for(const[name,c]of Object.entries(contracts))artifacts[name]={file,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,runtime:'0x'+c.evm.deployedBytecode.object};
 return{artifacts,evidence:{compiler:solc.version(),settings,sourceSha256:Object.fromEntries(Object.entries(sources).map(([file,{content}])=>[file,sha(content)]))}};
}

test('fixed storage banks preserve mutable/snapshot ABI without per-page or per-run contracts',async t=>{
 const report={schemaVersion:1,status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'Local fixed-bank storage and selected real harmonic forces; no full prepared molecular force pass, production ensemble or target-chain fee claim.',
  testSourceSha256:sha(fs.readFileSync(new URL(import.meta.url))),gas:[]};
 const save=()=>{fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/banked_state_validation.json',JSON.stringify(report,null,2)+'\n');};save();
 try{
  const{artifacts,evidence}=compileFixture();report.compilation=evidence;
  const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
  t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
  const owner=await provider.getSigner(0),other=await provider.getSigner(1);
  async function deploy(name,args=[]){const a=artifacts[name],c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args);await c.waitForDeployment();return c;}
  const transaction=async p=>(await p).wait();
  const capture=(scenario,receipt)=>report.gas.push({scenario,localReceiptGas:String(receipt.gasUsed)});
  const writer=await deploy('WorkingStateWriterHarness');const writerAddress=await writer.getAddress();
  const state=await deploy('BankedWorkingState',[writerAddress,128]),address=await state.getAddress();
  capture('router deployment without storage-bank creation',await state.deploymentTransaction().wait());
  const call=(name,args)=>writer.forward(address,state.interface.encodeFunctionData(name,args),{gasLimit});
  const reject=(name,args)=>assert.rejects(writer.forward.staticCall(address,state.interface.encodeFunctionData(name,args)));
  const ns=id('fixed-bank-full-index-space');let successful=0;

  await t.test('provisioning is bounded and failed cross-bank writes roll back entirely',async()=>{
   const factory=new ContractFactory(artifacts.BankedWorkingState.abi,artifacts.BankedWorkingState.bytecode,owner);
   for(const[badWriter,banks]of [[ZeroAddress,2],[await owner.getAddress(),2],[writerAddress,0],[writerAddress,129]]){
    const tx=await factory.getDeployTransaction(badWriter,banks);await assert.rejects(provider.call({data:tx.data}));
   }
   assert.equal(await state.bankCount(),128n);assert.equal(await state.deployedBankCount(),0n);
   await assert.rejects(state.createNamespace(ns,1196425));
   await reject('createNamespace',[ZeroHash,1]);await reject('createNamespace',[ns,0]);
   await transaction(call('createNamespace',[ns,1196425]));
   assert.equal(await state.readWord(ns,4095),ZeroHash);
   await reject('writeWord',[ns,4095,integer(1)]);
   await assert.rejects(state.deployBanks.staticCall(0));await assert.rejects(state.deployBanks.staticCall(5));
   capture('first bank deployed permissionlessly',await transaction(state.connect(other).deployBanks(1,{gasLimit})));
   const before=[...await state.namespaceCommitment(ns)];
   await assert.rejects(transaction(call('writeWords',[ns,4095,[integer(1),integer(2)]])));
   assert.equal(await state.readWord(ns,4095),ZeroHash);assert.deepEqual([...await state.namespaceCommitment(ns)],before);
   while(await state.deployedBankCount()<128n)capture('bounded remaining bank provisioning',await transaction(state.connect(other).deployBanks(4,{gasLimit})));
   assert.deepEqual([...await state.deployBanks.staticCall(4)],[0n,true]);
   const bankFactory=new ContractFactory(artifacts.BankedStateStorageBank.abi,artifacts.BankedStateStorageBank.bytecode,owner);
   const initHash=keccak256((await bankFactory.getDeployTransaction(address)).data),pages=[];
   for(let i=0;i<128;++i){
    const info=await state.bankInfo(i);pages.push(info.page);
    assert.equal(info.page,getCreate2Address(address,integer(i),initHash));
    assert.equal(info.codeHash,await state.bankRuntimeCodeHash());
   }
   assert.equal(new Set(pages).size,128);assert.equal(await provider.send('eth_getTransactionCount',[address,'latest']),'0x81');
   await assert.rejects(state.bankInfo(128));
   report.fixedPool={configuredBanks:128,deployedBanks:128,routerContracts:1,totalProductionAddressesForThisStorageModule:129,
    constructorCreatesBanks:false,perNamespaceCreatesBanks:false,maximumBanksPerProvisionCall:4};
   ++successful;
  });

  await t.test('global-index and namespace keys remain distinct when logical pages share banks',async()=>{
   const otherNs=id('independent-window'),first=id('banked-retained-step-1'),second=id('banked-retained-step-2');
   await transaction(call('createNamespace',[otherNs,1196425]));
   const values=Array.from({length:128},(_,i)=>integer(i+1));
   capture('128-word cold batch across two logical pages',await transaction(call('writeWords',[ns,4093,values])));
   const collision=4093+128*4096;
   assert.equal((await state.shardInfo(ns,0)).page,(await state.shardInfo(ns,128)).page);
   await transaction(call('writeWord',[ns,collision,integer(600)]));
   await transaction(call('writeWord',[otherNs,4093,integer(700)]));
   capture('immutable checkpoint creation',await transaction(call('snapshotNamespace',[ns,first])));
   assert.deepEqual([...await state.readWords(first,4093,128)],values);
   const updated=values.map(v=>integer(BigInt(v)+1000n));
   await transaction(call('writeWords',[ns,4093,updated]));
   await transaction(call('writeWord',[ns,200000,integer(800)]));
   await transaction(call('writeWord',[ns,collision,integer(900)]));
   await transaction(call('snapshotNamespace',[ns,second]));
   assert.deepEqual([...await state.readWords(first,4093,128)],values);
   assert.deepEqual([...await state.readWords(second,4093,128)],updated);
   assert.equal(await state.readWord(first,collision),integer(600));assert.equal(await state.readWord(second,collision),integer(900));
   assert.equal(await state.readWord(first,200000),ZeroHash);assert.equal(await state.readWord(second,200000),integer(800));
   assert.equal(await state.readWord(otherNs,4093),integer(700));
   await reject('writeWord',[first,0,integer(1)]);await reject('snapshotNamespace',[first,id('nested')]);
   await reject('snapshotNamespace',[ns,first]);await assert.rejects(state.snapshotInfo(ns));
   await transaction(call('sealNamespace',[ns]));await reject('writeWord',[ns,0,integer(1)]);
   assert.equal((await state.namespaceInfo(first)).isSealed,true);
   const maxNs=id('uint32-capacity'),capacity=2n**32n-1n,index=capacity-1n;
   await transaction(call('createNamespace',[maxNs,capacity]));
   await transaction(call('writeWord',[maxNs,index,integer(1234)]));
   assert.equal(await state.readWord(maxNs,index),integer(1234));
   await reject('writeWord',[maxNs,capacity,integer(1)]);await assert.rejects(state.readWord(maxNs,capacity));
   assert.deepEqual([...await state.readWords(maxNs,capacity,0)],[]);
   await reject('writeWords',[maxNs,0,[]]);await assert.rejects(state.readWords(maxNs,0,129));
   await assert.rejects(state.readWord(maxNs,2n**256n-1n));
   for(let i=0;i<8;++i){const name=id('additional-run-'+i);await transaction(call('createNamespace',[name,1196425]));await transaction(call('writeWord',[name,1196424,integer(i+1)]));}
   assert.equal(await provider.send('eth_getTransactionCount',[address,'latest']),'0x81');
   report.isolation={distinctNamespaces:true,logicalPageWrapDoesNotAlias:true,historicalUnwrittenWordIsZero:true,
    maximumCapacityWords:String(capacity),largestWrittenWordIndex:String(index),additionalRunContractsCreated:0};
   ++successful;
  });

  await t.test('partitioned writes retain exact digests/snapshots and code changes fail closed',async()=>{
   const name=id('partitioned-write'),snapshot=id('partitioned-snapshot'),start=65530;
   await transaction(call('createNamespace',[name,900001]));
   const values=Array.from({length:128},(_,i)=>integer(i+2000)),initial=(await state.namespaceCommitment(name)).writeDigest;
   let expected=initial;for(let i=0;i<128;++i)expected=keccak256(coder.encode(['bytes32','uint256','bytes32'],[expected,start+i,values[i]]));
   const branch=await provider.send('evm_snapshot',[]);
   await transaction(call('writeWords',[name,start,values]));await transaction(call('snapshotNamespace',[name,snapshot]));
   const first=[...await state.snapshotInfo(snapshot)];assert.equal(first[3],expected);
   assert.equal(await provider.send('evm_revert',[branch]),true);
   let done=0;for(const size of[1,7,31,89]){await transaction(call('writeWords',[name,start+done,values.slice(done,done+size)]));done+=size;}
   await transaction(call('snapshotNamespace',[name,snapshot]));assert.deepEqual([...await state.snapshotInfo(snapshot)],first);
   assert.deepEqual([...await state.readWords(snapshot,start,128)],values);
   const retained=[];
   for(let epoch=2;epoch<=20;++epoch){await transaction(call('writeWord',[name,start,integer(epoch)]));const s=id('retained-epoch-'+epoch);await transaction(call('snapshotNamespace',[name,s]));retained.push(s);}
   assert.equal(await state.readWord(snapshot,start),values[0]);assert.equal(await state.readWord(retained[8],start),integer(10));
   capture('epoch1 historical read after20 epochs',{gasUsed:await state.readWord.estimateGas(snapshot,start)});
   const bank=(await state.bankInfo(0)).page,bankContract=new Contract(bank,artifacts.BankedStateStorageBank.abi,owner);
   await assert.rejects(bankContract.writeWords(name,0,[integer(1)],21));await assert.rejects(bankContract.readWords(name,0,1,1));
   const routerCode=await provider.getCode(address);await provider.send('evm_setAccountCode',[address,'0x00']);
   await assert.rejects(provider.call({from:address,to:bank,data:bankContract.interface.encodeFunctionData('writeWords',[name,0,[integer(1)],21])}));
   await provider.send('evm_setAccountCode',[address,routerCode]);
   const bank1=(await state.bankInfo(1)).page,original=await provider.getCode(bank1),digest=[...await state.namespaceCommitment(name)];
   const originalValue=await state.readWord(name,4095);
   await provider.send('evm_setAccountCode',[bank1,'0x00']);
   await assert.rejects(state.readWord(name,4096));
   await assert.rejects(transaction(call('writeWords',[name,4095,[integer(55),integer(66)]])));
   await provider.send('evm_setAccountCode',[bank1,original]);
   assert.equal(await state.readWord(name,4095),originalValue);assert.deepEqual([...await state.namespaceCommitment(name)],digest);
   const writerCode=await provider.getCode(writerAddress);await provider.send('evm_setAccountCode',[writerAddress,'0x00']);
   await assert.rejects(provider.call({from:writerAddress,to:address,data:state.interface.encodeFunctionData('writeWord',[name,0,integer(1)])}));
   await provider.send('evm_setAccountCode',[writerAddress,writerCode]);
   report.integrity={batchPartitionDigestAndSnapshotExact:true,retainedEpochs:20,directBankAccessRejected:true,
    changedBankRejected:true,changedWriterRejected:true,changedRouterRejectedByBank:true,crossBankWriteRollback:true};
   ++successful;
  });

  await t.test('existing typed consumer computes real cross-bank forces and uint64 checkpoints',async()=>{
   const abi=new Interface(artifacts.ShardedWorkingState.abi);
   for(const signature of ['writer()','createNamespace(bytes32,uint32)','writeWord(bytes32,uint256,bytes32)','writeWords(bytes32,uint256,bytes32[])',
    'readWord(bytes32,uint256)','readWords(bytes32,uint256,uint256)','snapshotNamespace(bytes32,bytes32)','snapshotInfo(bytes32)',
    'namespaceInfo(bytes32)','namespaceCommitment(bytes32)','sealNamespace(bytes32)']){
    assert.equal(state.interface.getFunction(signature).format('full'),abi.getFunction(signature).format('full'));
   }
   const math=await deploy('FloatMath'),kernel=await deploy('HarmonicBondKernel',[await math.getAddress()]);
   const consumer=await deploy('ShardedStateForceHarness'),bounded=await deploy('BankedWorkingState',[await consumer.getAddress(),2]);
   await transaction(bounded.deployBanks(2,{gasLimit}));
   const begin=2n**32n+5n;await transaction(consumer.configure(await bounded.getAddress(),await kernel.getAddress(),132936,begin,begin+2n));
   const a=455,b=132935,name=await consumer.namespace();
   await transaction(consumer.setParticle(a,qvec([0,0,0]),qvec([0,0,0])));
   await transaction(consumer.setParticle(b,qvec([2,0,0]),qvec([0,0,0])));
   capture('real harmonic force at132936-atom global indices',await transaction(consumer.evaluateBond(a,b,q(3),q(1))));
   assert.deepEqual([...await bounded.readWords(name,a*9+6,3)],[q(3),q(0),q(0)].map(word));
   assert.equal(await bounded.readWord(name,132936*9),word(q(1.5)));
   const first=await consumer.commitStep.staticCall();await transaction(consumer.commitStep());
   await transaction(consumer.setParticle(b,qvec([3,0,0]),qvec([0,0,0])));
   await transaction(consumer.evaluateBond(a,b,q(3),q(1)));await transaction(consumer.commitStep());
   assert.equal(await consumer.completedSteps(),begin+2n);await assert.rejects(consumer.commitStep.staticCall());
   assert.equal(await bounded.readWord(first,b*9),word(q(2)));assert.equal(await bounded.readWord(name,b*9),word(q(3)));
   assert.equal(await bounded.readWord(first,132936*9),word(q(1.5)));assert.equal(await bounded.readWord(name,132936*9),word(q(6)));
   assert.equal(await bounded.deployedBankCount(),2n);
   report.consumer={legacyTypedABICompatible:true,namespaceCapacityWords:1196425,globalAtoms:132936,
    particlesActuallyEvaluated:2,completeLargeForcePass:false,checkpointBeyondUint32:true,bankCount:2};
   ++successful;
  });
  assert.equal(successful,4);report.passed=true;report.status='passed';
 }finally{save();}
});
