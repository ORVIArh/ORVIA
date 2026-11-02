import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Contract, encodeBytes32String, id, keccak256, toBeHex, zeroPadValue, ZeroHash } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q } from './helpers.mjs';

const floating = x => zeroPadValue(q(x), 32);
const integer = x => toBeHex(x, 32);

test('Dynamics datasets preserve trusted paged schemas and immutable base identity', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const { owner, contributor, provider } = env;
  const ownerAddress = await owner.getAddress();
  const base = await deploy('DatasetCatalog', owner, [ownerAddress]);
  await assert.rejects(deploy('DynamicsDataset', owner, [ownerAddress, ownerAddress]));
  const dynamics = await deploy('DynamicsDataset', owner, [ownerAddress, await base.getAddress()]);
  const baseId = id('dynamics-test-base');
  const roles = ['PARTICLES', 'ANGLES', 'TORSIONS', 'PAIRS'].map(x => id(`ORVIA.${x}.v1`));
  let sequence = 0;

  async function makePage(factory, role, words, seal = true) {
    const receipt = await transact(factory.createPage(role, words.length));
    const event = receipt.logs.map(log => {
      try { return factory.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === 'PageCreated');
    assert.ok(event);
    const page = new Contract(event.args.page, artifacts.DataPage.abi, owner);
    await transact(page.append(words));
    if (seal) await transact(page.seal(await page.rollingDigest()));
    return page;
  }
  async function makeStream(role, words, splits = []) {
    const boundaries = [0, ...splits, words.length], pages = [];
    for (let i = 1; i < boundaries.length; i++) pages.push(await makePage(dynamics, role, words.slice(boundaries[i - 1], boundaries[i])));
    return pages;
  }
  const positions = [0,0,0, 1,0,0, 1,1,0, 1,1,1].map(floating);
  const bonds = [integer(0), integer(1), floating(2), floating(1)];
  const basePositions = await makePage(base, id('ORVIA.POSITIONS.v1'), positions);
  const baseBonds = await makePage(base, id('ORVIA.BONDS.v1'), bonds);
  await transact(base.registerDataset(baseId, [await basePositions.getAddress()], [await baseBonds.getAddress()], 4, 1));
  const sourceWords = [
    [12,0,0,0, 14,0.25,0,0, 16,0,-0.25,0, 12,0,0,0.5].map(floating),
    [integer(0),integer(1),integer(2),floating(2),floating(1.5), integer(1),integer(2),integer(3),floating(3),floating(1.25)],
    [integer(0),integer(1),integer(2),integer(3),integer(2),floating(0.25),floating(0.5)],
    [integer(0),integer(3),floating(0.5),floating(0.125),floating(-0.25),floating(1)]
  ];
  const splitAt = [[5], [2,7], [4], [1,3]];
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await makeStream(roles[i], sourceWords[i], splitAt[i]));
  const addresses = await Promise.all(pages.map(stream => Promise.all(stream.map(p => p.getAddress()))));
  const registration = {
    baseDatasetId: baseId, particlePages: addresses[0], anglePages: addresses[1],
    torsionPages: addresses[2], pairPages: addresses[3], angleCount: 2, torsionCount: 1, pairCount: 1
  };
  const fullId = id('dynamics-full');
  await transact(dynamics.registerDataset(fullId, registration));
  const readers = ['readParticleWord', 'readAngleWord', 'readTorsionWord', 'readPairWord'];

  await t.test('reads all streams across record-splitting boundaries and delegates the frozen base', async () => {
    assert.equal(await dynamics.baseCatalog(), await base.getAddress());
    const info = await dynamics.datasetInfo(fullId);
    assert.deepEqual([...info].slice(1), [baseId,4n,1n,2n,1n,1n]);
    assert.equal(await dynamics.assertDataset(fullId), info.commitment);
    for (let stream = 0; stream < 4; stream++) {
      assert.equal(await dynamics.pageCount(fullId, stream), BigInt(pages[stream].length));
      for (let i = 0; i < sourceWords[stream].length; i++) assert.equal(await dynamics[readers[stream]](fullId, i), sourceWords[stream][i]);
      await assert.rejects(dynamics[readers[stream]](fullId, sourceWords[stream].length));
    }
    for (let i = 0; i < positions.length; i++) assert.equal(await dynamics.readPositionWord(fullId, i), positions[i]);
    for (let i = 0; i < bonds.length; i++) assert.equal(await dynamics.readBondWord(fullId, i), bonds[i]);
    await assert.rejects(dynamics.pageCount(fullId, 4));
    await assert.rejects(dynamics.pageInfo(fullId, 0, pages[0].length));
    await assert.rejects(dynamics.readParticleWord(id('unknown'), 0));
  });

  await t.test('independently reconstructs page digests and the complete dynamics commitment', async () => {
    const coder = AbiCoder.defaultAbiCoder();
    const hash = (types, values) => keccak256(coder.encode(types, values));
    const streamHashes = [];
    for (let s = 0; s < 4; s++) {
      let streamHash = hash(['bytes32','uint256'], [roles[s],pages[s].length]), offset = 0;
      for (let i = 0; i < pages[s].length; i++) {
        const page = pages[s][i], address = await page.getAddress();
        const count = Number(await page.wordCount()), capacity = await page.capacityWords();
        let digest = hash(['bytes32','bytes32','uint32'], [encodeBytes32String('ORVIA-DATA-PAGE-v1'),roles[s],capacity]);
        for (const word of sourceWords[s].slice(offset, offset + count)) digest = hash(['bytes32','bytes32'], [digest,word]);
        offset += count;
        assert.equal(await page.rollingDigest(), digest);
        const codeHash = keccak256(await provider.getCode(address));
        assert.deepEqual([...await dynamics.pageInfo(fullId,s,i)], [address,codeHash,digest,BigInt(count)]);
        streamHash = hash(['bytes32','uint256','address','bytes32','uint32','bytes32'], [streamHash,i,address,codeHash,count,digest]);
      }
      assert.equal(offset,sourceWords[s].length);
      streamHashes.push(streamHash);
    }
    const baseAddress = await base.getAddress();
    const baseHeader = hash(['address','bytes32','bytes32','bytes32','uint32','uint32'],
      [baseAddress,keccak256(await provider.getCode(baseAddress)),baseId,(await base.datasetInfo(baseId)).commitment,4,1]);
    const commitment = hash(['bytes32','uint256','address','bytes32','bytes32','uint32[4]','bytes32[4]'],
      [id('ORVIA.DYNAMICS.DATASET.v1'),31337,await dynamics.getAddress(),fullId,baseHeader,[4,2,1,1],streamHashes]);
    assert.equal((await dynamics.datasetInfo(fullId)).commitment,commitment);
  });

  await t.test('optional zero-count streams are genuinely empty and dataset IDs remain immutable', async () => {
    const minimal = {...registration,anglePages:[],torsionPages:[],pairPages:[],angleCount:0,torsionCount:0,pairCount:0};
    const minimalId = id('dynamics-minimal');
    await transact(dynamics.registerDataset(minimalId,minimal));
    assert.deepEqual([...(await dynamics.datasetInfo(minimalId))].slice(4),[0n,0n,0n]);
    for(let s=1;s<4;s++){
      assert.equal(await dynamics.pageCount(minimalId,s),0n);
      await assert.rejects(dynamics[readers[s]](minimalId,0));
    }
    await assert.rejects(transact(dynamics.registerDataset(minimalId,registration)));
    const duplicateInputsId=id('dynamics-same-inputs-new-id');
    await transact(dynamics.registerDataset(duplicateInputsId,minimal));
    assert.notEqual((await dynamics.datasetInfo(minimalId)).commitment,(await dynamics.datasetInfo(duplicateInputsId)).commitment);
    await assert.rejects(transact(dynamics.registerDataset(id('nonempty-zero'),{...minimal,anglePages:addresses[1]})));
    await assert.rejects(transact(dynamics.registerDataset(id('empty-nonzero'),{...minimal,angleCount:1})));
  });

  await t.test('enforces ownership, factory provenance, sealing, roles, limits and atomic registration', async () => {
    await assert.rejects(transact(dynamics.connect(contributor).createPage(roles[0],1)));
    await assert.rejects(transact(dynamics.createPage(id('invalid-role'),1)));
    await assert.rejects(transact(dynamics.connect(contributor).registerDataset(id('wrong-owner'),registration)));
    await assert.rejects(transact(dynamics.registerDataset(ZeroHash,registration)));
    await assert.rejects(transact(dynamics.registerDataset(id('bad-base'),{...registration,baseDatasetId:id('unknown-base')})));
    await assert.rejects(transact(dynamics.registerDataset(id('too-many'),{...registration,angleCount:4097})));
    await assert.rejects(transact(dynamics.registerDataset(id('too-many-pages'),{...registration,particlePages:Array(17).fill(addresses[0][0])})));
    await assert.rejects(transact(dynamics.registerDataset(id('duplicate-page'),{...registration,particlePages:[addresses[0][0],addresses[0][0]]})));
    await assert.rejects(transact(dynamics.registerDataset(id('cross-stream-duplicate'),{...registration,pairPages:[addresses[0][0]]})));
    await assert.rejects(transact(dynamics.registerDataset(id('wrong-role'),{...registration,particlePages:addresses[1]})));
    const unsealed=await makePage(dynamics,roles[0],sourceWords[0],false);
    await assert.rejects(transact(dynamics.registerDataset(id('unsealed'),{...registration,particlePages:[await unsealed.getAddress()]})));
    const external=await deploy('DataPage',owner,[ownerAddress,roles[0],sourceWords[0].length]);
    await transact(external.append(sourceWords[0]));await transact(external.seal(await external.rollingDigest()));
    await assert.rejects(transact(dynamics.registerDataset(id('untrusted'),{...registration,particlePages:[await external.getAddress()]})));
    const retried=id('retry-after-revert');
    await assert.rejects(transact(dynamics.registerDataset(retried,{...registration,pairCount:2},{gasLimit:12000000})));
    await assert.rejects(dynamics.datasetInfo(retried));
    await transact(dynamics.registerDataset(retried,registration));
    assert.equal((await dynamics.datasetInfo(retried)).baseDatasetId,baseId);
  });

  await t.test('canonical widths use global field indices even when records cross pages', async () => {
    const fields=[['particlePages',0,0,128],['anglePages',1,2,32],['torsionPages',2,4,32],['pairPages',3,4,128]];
    for(const [key,stream,index,width] of fields){
      const words=[...sourceWords[stream]];words[index]=integer(BigInt(words[index])|(1n<<BigInt(width)));
      const dirty=await makeStream(roles[stream],words,index===0?[]:[index]);
      const dirtyId=id(`dirty-dynamics-${++sequence}`);
      await transact(dynamics.registerDataset(dirtyId,{...registration,[key]:await Promise.all(dirty.map(p=>p.getAddress()))}));
      await assert.rejects(dynamics[readers[stream]](dirtyId,index));
    }
    // A canonical NaN is still raw schema-valid data. Numerical validation belongs to the coordinator.
    const words=[...sourceWords[0]];words[0]=zeroPadValue('0x7fff8000000000000000000000000000',32);
    const rawPage=await makePage(dynamics,roles[0],words), rawId=id('raw-nan-particle');
    await transact(dynamics.registerDataset(rawId,{...registration,particlePages:[await rawPage.getAddress()]}));
    assert.equal(await dynamics.readParticleWord(rawId,0),words[0]);
  });
});
