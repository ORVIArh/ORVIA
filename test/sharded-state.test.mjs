import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract, AbiCoder, encodeBytes32String, id, keccak256, toBeHex, ZeroHash, ZeroAddress, zeroPadValue } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q, qvec } from './helpers.mjs';

const word = v => zeroPadValue(v, 32);
const integer = v => toBeHex(v, 32);
const coder = AbiCoder.defaultAbiCoder();
const gas = [];
const capture = (scenario, receipt, extra={}) => gas.push({scenario, localGas:receipt.gasUsed.toString(),...extra});

test('sharded state retains authenticated immutable views beyond one-page and old65536-word capacity', async t => {
  const env=await environment(); t.after(()=>env.transport.disconnect());
  const writer=await deploy('WorkingStateWriterHarness',env.owner);
  const state=await deploy('ShardedWorkingState',env.owner,[await writer.getAddress()]);
  const address=await state.getAddress();
  const forward=(name,args)=>writer.forward(address,state.interface.encodeFunctionData(name,args));
  const rejects=(name,args)=>assert.rejects(writer.forward.staticCall(address,state.interface.encodeFunctionData(name,args)));
  const ns=id('100000-atom-working-state'), first=id('complete-step-first'), second=id('complete-step-second');
  await assert.rejects(state.createNamespace(ns,900001));
  await rejects('createNamespace',[ZeroHash,900001]);
  capture('create900001-word namespace without all-page allocation',await transact(forward('createNamespace',[ns,900001])));
  assert.deepEqual([...await state.namespaceInfo(ns)],[900001n,false]);
  assert.equal(await state.readWord(ns,900000),ZeroHash);
  assert.equal((await state.shardInfo(ns,219))[0],ZeroAddress);
  const values=Array.from({length:9},(_,i)=>integer(i+1));
  capture('cold9-word write crossing4096 boundary',await transact(forward('writeWords',[ns,4093,values])));
  assert.deepEqual([...await state.readWords(ns,4093,9)],values);
  const last=integer(987654321);
  capture('cold write above old65536 capacity',await transact(forward('writeWord',[ns,899999,last])));
  capture('snapshot epoch checkpoint',await transact(forward('snapshotNamespace',[ns,first])));
  const info=await state.snapshotInfo(first);
  assert.equal(info.source,ns); assert.equal(info.epoch,1n); assert.equal(info.capacityWords,900001n);
  assert.notEqual(info.commitment,ZeroHash);
  assert.deepEqual([...await state.namespaceInfo(first)],[900001n,true]);
  await rejects('writeWord',[first,0,last]);
  await rejects('snapshotNamespace',[first,id('nested-snapshot')]);
  await rejects('snapshotNamespace',[ns,first]);
  await assert.rejects(state.snapshotInfo(ns));
  const updated=values.map(v=>integer(BigInt(v)+100n));
  capture('first postcheckpoint9-word write crossing shards',await transact(forward('writeWords',[ns,4093,updated])));
  capture('repeated same-epoch9-word write crossing shards',await transact(forward('writeWords',[ns,4093,values])));
  await transact(forward('writeWord',[ns,899999,ZeroHash]));
  await transact(forward('writeWord',[ns,200000,last])); // shard did not exist at prior snapshot.
  capture('second snapshot checkpoint',await transact(forward('snapshotNamespace',[ns,second])));
  assert.equal((await state.snapshotInfo(second)).epoch,2n);
  assert.equal(await state.readWord(first,899999),last);
  assert.equal(await state.readWord(second,899999),ZeroHash);
  assert.equal(await state.readWord(first,200000),ZeroHash);
  assert.equal(await state.readWord(second,200000),last);
  assert.deepEqual([...await state.readWords(first,4093,9)],values);
  assert.deepEqual([...await state.readWords(second,4093,9)],values);
  await rejects('writeWord',[ns,900001,last]);
  await rejects('writeWords',[ns,900000,[last,last]]);
  await assert.rejects(state.readWords(ns,0,129));
  await assert.rejects(state.readWord(ns,toBeHex(2n**256n-1n)));
  await transact(forward('sealNamespace',[ns]));
  await rejects('writeWord',[ns,0,last]);
  assert.equal(await state.readWord(first,899999),last);
  const shardAddress=(await state.shardInfo(ns,0))[0];
  const shard=new Contract(shardAddress,artifacts.VersionedStateShard.abi,env.owner);
  await assert.rejects(shard.writeWords(0,[last],3));
  await env.provider.send('evm_setAccountCode',[shardAddress,'0x00']);
  await assert.rejects(state.readWord(ns,4093));
  await assert.rejects(state.readWord(first,4093));
});

test('snapshot byte retention and write commitments are independent of batch partition',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const writer=await deploy('WorkingStateWriterHarness',env.owner);
  const state=await deploy('ShardedWorkingState',env.owner,[await writer.getAddress()]);
  const address=await state.getAddress(); const chainId=(await env.provider.getNetwork()).chainId;
  const call=(name,args)=>writer.forward(address,state.interface.encodeFunctionData(name,args));
  for (const chunks of [[128],[1,7,31,89]]) {
    const ns=id('partition-'+chunks.join('-')),capacity=900001;
    await transact(call('createNamespace',[ns,capacity]));
    let expected=keccak256(coder.encode(['bytes32','uint256','address','address','bytes32','uint32'],
      [encodeBytes32String('ORVIA-SHARDED-STATE-v1'),chainId,address,await writer.getAddress(),ns,capacity]));
    const values=Array.from({length:128},(_,i)=>integer(i+1));let offset=0;
    for (const size of chunks) {
      const receipt=await transact(call('writeWords',[ns,65530+offset,values.slice(offset,offset+size)]));
      if(chunks.length===1)capture('maximum128-word batch crossing two cold shards',receipt);
      offset+=size;
    }
    for (let i=0;i<values.length;i++) expected=keccak256(coder.encode(['bytes32','uint256','bytes32'],[expected,65530+i,values[i]]));
    assert.equal((await state.namespaceCommitment(ns)).writeDigest,expected);
    const snapshots=[];
    for(let epoch=1;epoch<=20;epoch++) {
      const snapshot=id(ns+'-'+epoch);await transact(call('snapshotNamespace',[ns,snapshot]));snapshots.push(snapshot);
      await transact(call('writeWord',[ns,65530,integer(epoch+1000)]));
    }
    assert.equal(await state.readWord(snapshots[0],65530),integer(1));
    assert.equal(await state.readWord(snapshots[10],65530),integer(1010));
    assert.equal(await state.readWord(snapshots[19],65530),integer(1019));
    capture('retained epoch1 read after20 snapshots',{gasUsed:await state.readWord.estimateGas(snapshots[0],65530)});
  }
});

test('real bond forces cross shards at100000-atom global indices and checkpoints resume beyonduint32 steps',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const math=await deploy('FloatMath',env.owner), kernel=await deploy('HarmonicBondKernel',env.owner,[await math.getAddress()]);
  const consumer=await deploy('ShardedStateForceHarness',env.owner);
  const state=await deploy('ShardedWorkingState',env.owner,[await consumer.getAddress()]);
  const start=2n**32n+5n;await transact(consumer.configure(await state.getAddress(),await kernel.getAddress(),100000,start,start+2n));
  const ns=await consumer.namespace();const a=455,b=99999; // atom455 spans a4096-word boundary.
  await transact(consumer.setParticle(a,qvec([0,0,0]),qvec([0,0,0])));
  await transact(consumer.setParticle(b,qvec([2,0,0]),qvec([0,0,0])));
  capture('real harmonic force across distant100000-atom shards',await transact(consumer.evaluateBond(a,b,q(3),q(1))));
  const expected=await kernel.evaluate(qvec([0,0,0]),qvec([2,0,0]),q(3),q(1));
  assert.deepEqual([...await state.readWords(ns,a*9+6,3)],expected[1].map(word));
  assert.equal(await state.readWord(ns,900000),word(expected[0]));
  const first=await consumer.commitStep.staticCall();await transact(consumer.commitStep());
  assert.equal(await consumer.completedSteps(),start+1n);
  await transact(consumer.setParticle(b,qvec([3,0,0]),qvec([0,0,0])));
  await transact(consumer.evaluateBond(a,b,q(3),q(1)));
  await transact(consumer.commitStep());assert.equal(await consumer.completedSteps(),start+2n);
  await assert.rejects(consumer.commitStep.staticCall());
  assert.equal(await state.readWord(first,b*9),word(q(2)));
  assert.equal(await state.readWord(ns,b*9),word(q(3)));
  assert.equal(await state.readWord(first,900000),word(expected[0]));
});

test('existing paged force coordinator consumes sharded state with cross-page1500-atom inputs and partition-equivalent forces',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const owner=await env.owner.getAddress();
  const math=await deploy('FloatMath',env.owner),kernel=await deploy('HarmonicBondKernel',env.owner,[await math.getAddress()]);
  const registry=await deploy('ExperimentRegistry',env.owner,[owner]);
  const catalog=await deploy('DatasetCatalog',env.owner,[owner]);
  const coordinator=await deploy('PagedBondCoordinator',env.owner,[owner,await math.getAddress(),await kernel.getAddress(),await registry.getAddress(),await catalog.getAddress()]);
  const state=await deploy('ShardedWorkingState',env.owner,[await coordinator.getAddress()]);
  await transact(coordinator.bindWorkingPage(await state.getAddress()));
  const protocol=id('1500atom-sharded-existing-coordinator');
  await transact(registry.registerProtocol(protocol,id('cross-page-real-harmonic-fixture'),await Promise.all([math,kernel,catalog,state,coordinator].map(c=>c.getAddress()))));
  async function page(role,values){
    const receipt=await transact(catalog.createPage(role,values.length));
    const e=receipt.logs.map(log=>{try{return catalog.interface.parseLog(log);}catch{return null;}}).find(log=>log?.name==='PageCreated');
    const input=new Contract(e.args.page,artifacts.DataPage.abi,env.owner);
    for(let j=0;j<values.length;j+=128)await transact(input.append(values.slice(j,j+128),{gasLimit:4_000_000}));
    await transact(input.seal(await input.rollingDigest()));return input.getAddress();
  }
  const atoms=1500,a=1365,b=1499,positions=Array(atoms*3).fill(word(q(0)));positions[b*3]=word(q(2));
  const p0=await page(await catalog.POSITION_ROLE(),positions.slice(0,4096));
  const p1=await page(await catalog.POSITION_ROLE(),positions.slice(4096));
  const bonds=await page(await catalog.BOND_ROLE(),[integer(a),integer(b),word(q(3)),word(q(1))]);
  const dataset=id('1500-atom-real-input');await transact(catalog.registerDataset(dataset,[p0,p1],[bonds],atoms,1));
  const expected=await kernel.evaluate(qvec([0,0,0]),qvec([2,0,0]),q(3),q(1));
  for(const batch of [16,7]){
    const run=await coordinator.nextExperimentId();await transact(coordinator.registerExperiment(protocol,dataset));
    let calls=0;
    for(;;){const info=await coordinator.runInfo(run);if(info.status===4n)break;
      assert.ok(calls++<250);const receipt=await transact(coordinator.connect(env.contributor).advanceExperiment(run,batch,{gasLimit:4_000_000}));
      if((await coordinator.runInfo(run)).status===4n)capture('existing coordinator final cross-shard accumulation',receipt,{batch});
    }
    assert.deepEqual([...await coordinator.forceAt(run,a)],[...expected[1]]);
    assert.equal((await coordinator.runInfo(run)).totalEnergy,expected[0]);
    const namespace=(await coordinator.runInfo(run)).stateNamespace;
    assert.deepEqual([...await state.namespaceInfo(namespace)],[4501n,true]);
    assert.notEqual((await state.shardInfo(namespace,0))[0],ZeroAddress);
    assert.notEqual((await state.shardInfo(namespace,1))[0],ZeroAddress);
    await assert.rejects(coordinator.advanceExperiment.staticCall(run,1));
  }
});

test.after(()=>{
  fs.mkdirSync('reports',{recursive:true});
  fs.writeFileSync('reports/sharded_state_gas.json',JSON.stringify({schemaVersion:1,chainId:31337,
    scope:'Local sharded storage and real bond consumer fixtures; not full-model or target-chain feasibility.',gas},null,2)+'\n');
});
