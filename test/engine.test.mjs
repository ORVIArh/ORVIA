import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AbiCoder, id, ZeroHash, encodeBytes32String, keccak256 } from 'ethers';
import { environment, deploy, transact, qvec, quadFromNumber as q, quadToNumber } from './helpers.mjs';

test('Resumable component execution and input integrity', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const { owner, contributor } = env;
  const math = await deploy('FloatMath', owner);
  const kernel = await deploy('HarmonicBondKernel', owner, [await math.getAddress()]);
  const registry = await deploy('ExperimentRegistry', owner, [await owner.getAddress()]);
  const engine = await deploy('ResumableBondEngine', owner,
    [await owner.getAddress(), await math.getAddress(), await kernel.getAddress(), await registry.getAddress()]);
  const protocol = id('ORVIA-COMPONENT-VALIDATION-001');
  const modules = [await math.getAddress(), await kernel.getAddress(), await engine.getAddress()];
  await transact(registry.registerProtocol(protocol, id('fixed harmonic fixture, not ORVIA-001 protein protocol'), modules));
  const positions = [[0,0,0],[2,0,0],[2,3,0],[1,1,2]].map(qvec);
  const bonds = [[0,1,q(3),q(1)], [1,2,q(4),q(2)], [2,3,q(2),q(1)]];
  const gas = [];

  await t.test('registered protocol is immutable and rejects duplicate/no-code modules', async () => {
    await assert.rejects(transact(registry.registerProtocol(protocol,id('changed'),modules)));
    await assert.rejects(transact(registry.registerProtocol(id('dup'),id('spec'),[modules[0],modules[0]])));
    await assert.rejects(transact(registry.registerProtocol(id('eoa'),id('spec'),[await owner.getAddress()])));
    await assert.rejects(transact(registry.connect(contributor).registerProtocol(id('unauthorised'),id('spec'),modules)));
    assert.equal((await registry.getProtocol(protocol)).moduleCount,3n);
  });

  await t.test('one batch equals three committed batches bit-for-bit', async () => {
    await transact(engine.registerExperiment(protocol,positions,bonds));
    await transact(engine.registerExperiment(protocol,positions,bonds));
    const inputBefore = (await engine.runInfo(1)).inputHash;
    const one = await transact(engine.advanceExperiment(1,16));
    gas.push({scenario:'3 bonds in one transaction',gasUsed:one.gasUsed.toString()});
    for(let i=0;i<3;i++) {
      const receipt = await transact(engine.connect(contributor).advanceExperiment(2,1));
      gas.push({scenario:`single bond transaction ${i+1}`,gasUsed:receipt.gasUsed.toString()});
      const progress = await engine.runInfo(2);
      assert.equal(progress.cursor,BigInt(i+1));
      assert.equal(progress.status,i===2?3n:2n);
    }
    const a = await engine.runInfo(1), b = await engine.runInfo(2);
    assert.equal(a.totalEnergy,b.totalEnergy);
    assert.equal(a.inputHash,inputBefore);
    assert.equal(a.inputHash,b.inputHash);
    assert.notEqual(a.commitment,b.commitment); // run identity is part of the commitment
    const sum = [0,0,0];
    for(let atom=0;atom<positions.length;atom++) {
      const f = [...await engine.forceAt(1,atom)];
      assert.deepEqual(f,[...await engine.forceAt(2,atom)]);
      assert.deepEqual([...await engine.positionAt(1,atom)],positions[atom]);
      f.forEach((x,j)=>sum[j]+=quadToNumber(x));
    }
    sum.forEach(x=>assert.ok(Math.abs(x)<1e-12,'net internal force must vanish'));
    const analyticalEnergy=1.5+2+(Math.sqrt(9)-1)**2;
    assert.ok(Math.abs(quadToNumber(a.totalEnergy)-analyticalEnergy)<1e-12);
  });

  await t.test('permissions, bounds, missing run and completed run reject without state changes', async () => {
    await assert.rejects(transact(engine.connect(contributor).registerExperiment(protocol,positions,bonds)));
    await assert.rejects(transact(engine.advanceExperiment(99,1)));
    await assert.rejects(transact(engine.advanceExperiment(1,0)));
    await assert.rejects(transact(engine.advanceExperiment(1,17)));
    await assert.rejects(transact(engine.advanceExperiment(1,1)));
    await assert.rejects(transact(engine.registerExperiment(protocol,positions,[[0,0,q(1),q(1)]])));
    await assert.rejects(transact(engine.registerExperiment(protocol,positions,[[0,1,q(-1),q(1)]])));
    await assert.rejects(transact(engine.registerExperiment(protocol,[[q(0),q(0),'0x7fff0000000000000000000000000000'],positions[1]],bonds.slice(0,1))));
    assert.equal((await engine.runInfo(1)).cursor,3n);
  });

  await t.test('independently reconstructs input, protocol and complete run commitments',async()=>{
    const coder=AbiCoder.defaultAbiCoder();
    const hashes=await Promise.all(modules.map(async address=>keccak256(await env.provider.getCode(address))));
    const inputHash=keccak256(coder.encode(['bytes16[3][]','tuple(uint32 a,uint32 b,bytes16 k,bytes16 r0)[]'],[positions,bonds]));
    const manifestHash=keccak256(coder.encode(['bytes32','bytes32','address[]','bytes32[]'],
      [protocol,id('fixed harmonic fixture, not ORVIA-001 protein protocol'),modules,hashes]));
    assert.equal((await registry.getProtocol(protocol)).manifestHash,manifestHash);
    const registryAddress=await registry.getAddress();
    const commitment=keccak256(coder.encode(
      ['bytes32','uint256','address','uint256','bytes32','bytes32','address','bytes32','address','bytes32','address','bytes32'],
      [encodeBytes32String('ORVIA-BOND-FIXTURE-v1'),31337,modules[2],1,manifestHash,inputHash,
       modules[0],hashes[0],modules[1],hashes[1],registryAddress,keccak256(await env.provider.getCode(registryAddress))]));
    const run=await engine.runInfo(1);
    assert.equal(run.inputHash,inputHash);
    assert.equal(run.commitment,commitment);
  });

  await t.test('failure in a later bond rolls back ALL earlier work in the same transaction', async () => {
    const coincident=[[0,0,0],[2,0,0],[2,0,0]].map(qvec);
    await transact(engine.registerExperiment(protocol,coincident,bonds.slice(0,2)));
    const before=[...(await engine.runInfo(3))];
    await assert.rejects(transact(engine.advanceExperiment(3,2,{gasLimit:5000000})));
    assert.deepEqual([...(await engine.runInfo(3))],before);
    assert.deepEqual([...await engine.forceAt(3,0)],qvec([0,0,0]));
    await transact(engine.advanceExperiment(3,1));
    const afterFirst=[...(await engine.runInfo(3))];
    await assert.rejects(transact(engine.advanceExperiment(3,1,{gasLimit:5000000})));
    assert.deepEqual([...(await engine.runInfo(3))],afterFirst);
  });

  await t.test('input pages hash independently of upload batch boundaries and seal irreversibly',async()=>{
    const role=id('fixture-input');
    const pageA=await deploy('DataPage',owner,[await owner.getAddress(),role,4]);
    const pageB=await deploy('DataPage',owner,[await owner.getAddress(),role,4]);
    const words=[id('word0'),id('word1'),id('word2'),id('word3')];
    await transact(pageA.append(words));
    for(const word of words) await transact(pageB.append([word]));
    const coder=AbiCoder.defaultAbiCoder();
    let digest=keccak256(coder.encode(['bytes32','bytes32','uint32'],[encodeBytes32String('ORVIA-DATA-PAGE-v1'),role,4]));
    for(const word of words) digest=keccak256(coder.encode(['bytes32','bytes32'],[digest,word]));
    assert.equal(await pageA.rollingDigest(),digest);
    assert.equal(await pageB.rollingDigest(),digest);
    await assert.rejects(transact(pageA.append([id('overflow')])));
    await assert.rejects(transact(pageA.connect(contributor).seal(digest)));
    await assert.rejects(transact(pageA.seal(ZeroHash)));
    await transact(pageA.seal(digest));
    assert.equal(await pageA.isSealed(),true);
    assert.deepEqual([...await pageA.readWords(0,4)],words);
    await assert.rejects(transact(pageA.append([id('later')])));
    await assert.rejects(transact(pageA.seal(digest)));
  });

  await t.test('engine rejects omitted protocol dependencies',async()=>{
    await transact(registry.registerProtocol(id('incomplete'),id('spec'),modules.slice(0,2)));
    await assert.rejects(transact(engine.registerExperiment(id('incomplete'),positions,bonds)));
  });
  await t.test('21 shared-atom interactions agree across three different batch partitions',async()=>{
    const p=[[0,0,0],[1,2,3],[-2,0.5,1],[0.25,-1,2]].map(qvec);
    const many=Array.from({length:21},(_,i)=>[i%4,(i%4+i%3+1)%4,q(2**(i-10)),q([0,0.75,1.25,3.5][i%4])]);
    const first=await engine.nextExperimentId();
    const partitions=[[16,5],Array(21).fill(1),[7,4,10]];
    for(let r=0;r<partitions.length;r++){
      await transact(engine.registerExperiment(protocol,p,many));
      for(const n of partitions[r]) await transact(engine.connect(contributor).advanceExperiment(first+BigInt(r),n));
      assert.equal((await engine.runInfo(first+BigInt(r))).status,3n);
    }
    for(let r=1;r<partitions.length;r++){
      assert.equal((await engine.runInfo(first+BigInt(r))).totalEnergy,(await engine.runInfo(first)).totalEnergy);
      for(let atom=0;atom<p.length;atom++) assert.deepEqual(
        [...await engine.forceAt(first+BigInt(r),atom)],[...await engine.forceAt(first,atom)]);
    }
  });
  fs.writeFileSync('reports/local_execution_gas.json',JSON.stringify({
    scope:'Local Ganache Shanghai EVM component fixture only; not RH mainnet gas pricing, not full molecule or RBFE cost.',
    chainId:31337,transactions:gas
  },null,2)+'\n');
});
