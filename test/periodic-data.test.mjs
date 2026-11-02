import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Contract, encodeBytes32String, id, keccak256, toBeHex, zeroPadValue, ZeroHash, ZeroAddress } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q } from './helpers.mjs';

const floating = x => zeroPadValue(q(x), 32);
const integer = x => toBeHex(x, 32);
const rawQuad = x => toBeHex(x, 16);

test('Periodic datasets bind exhaustive pairs, trusted parameter pages and immutable periodic configuration', async t => {
  const env = await environment();
  t.after(() => env.transport.disconnect());
  const { owner, contributor, provider, transport } = env;
  const ownerAddress = await owner.getAddress();
  const base = await deploy('DatasetCatalog', owner, [ownerAddress]);
  const dynamics = await deploy('DynamicsDataset', owner, [ownerAddress, await base.getAddress()]);
  await assert.rejects(deploy('PeriodicDataset', owner, [ownerAddress, ownerAddress]));
  await assert.rejects(deploy('PeriodicDataset', owner, [ZeroAddress, await dynamics.getAddress()]));
  const periodic = await deploy('PeriodicDataset', owner, [ownerAddress, await dynamics.getAddress()]);
  const roles = ['NONBONDED','EXCEPTIONS'].map(x => id(`ORVIA.${x}.v1`));
  const baseId = id('periodic-base'), dynamicsId = id('periodic-dynamics'), fullId = id('periodic-full');
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
    for (let i = 1; i < boundaries.length; i++) pages.push(await makePage(periodic, role, words.slice(boundaries[i - 1], boundaries[i])));
    return pages;
  }
  const positions = [0,0,0, 1,0,0, 1,1,0, 1,1,1].map(floating);
  const bonds = [integer(0), integer(1), floating(2), floating(1)];
  const particles = [12,0,0,0, 14,0.25,0,0, 16,0,-0.25,0, 12,0,0,0.5].map(floating);
  const angles = [integer(0),integer(1),integer(2),floating(2),floating(1.5)];
  const torsions = [integer(0),integer(1),integer(2),integer(3),integer(2),floating(0.25),floating(0.5)];
  const basePositions = await makePage(base, id('ORVIA.POSITIONS.v1'), positions);
  const baseBonds = await makePage(base, id('ORVIA.BONDS.v1'), bonds);
  await transact(base.registerDataset(baseId, [await basePositions.getAddress()], [await baseBonds.getAddress()], 4, 1));
  const particlePage = await makePage(dynamics,id('ORVIA.PARTICLES.v1'),particles);
  const anglePage = await makePage(dynamics,id('ORVIA.ANGLES.v1'),angles);
  const torsionPage = await makePage(dynamics,id('ORVIA.TORSIONS.v1'),torsions);
  const dynamicsRegistration = {baseDatasetId:baseId,particlePages:[await particlePage.getAddress()],anglePages:[await anglePage.getAddress()],
    torsionPages:[await torsionPage.getAddress()],pairPages:[],angleCount:1,torsionCount:1,pairCount:0};
  await transact(dynamics.registerDataset(dynamicsId,dynamicsRegistration));
  const sourceWords = [
    [.5,.125,.25, .75,.25,-.5, 1,.5,.125, .625,.0625,-.25].map(floating),
    [integer(0),integer(1),integer(1),floating(0),floating(0),floating(0),
     integer(0),integer(3),integer(2),floating(.75),floating(.125),floating(-.0625)]
  ];
  const pages = [await makeStream(roles[0],sourceWords[0],[4]), await makeStream(roles[1],sourceWords[1],[2,7])];
  const addresses = await Promise.all(pages.map(stream=>Promise.all(stream.map(p=>p.getAddress()))));
  const registration = {dynamicsDatasetId:dynamicsId,nonbondedPages:addresses[0],exceptionPages:addresses[1],exceptionCount:2,
    box:[q(8),q(10),q(12)],switchDistance:q(2),cutoff:q(3),prefactor:q(1)};
  await transact(periodic.registerDataset(fullId,registration));

  await t.test('reads record-splitting streams, all delegated dynamics data, and complete pair cardinality', async () => {
    const info=await periodic.datasetInfo(fullId);
    assert.deepEqual([...info].slice(1),[dynamicsId,4n,1n,1n,1n,6n]);
    assert.equal(await periodic.assertDataset(fullId),info.commitment);
    assert.equal(await periodic.dynamicsCatalog(),await dynamics.getAddress());
    assert.deepEqual([...await periodic.periodicInfo(fullId)].map(v=>Array.isArray(v)?[...v]:v),[registration.box,q(2),q(3),q(1),2n]);
    for(const [reader,words] of [['readPositionWord',positions],['readBondWord',bonds],['readParticleWord',particles],['readAngleWord',angles],['readTorsionWord',torsions],['readNonbondedWord',sourceWords[0]],['readExceptionWord',sourceWords[1]]]){
      for(let i=0;i<words.length;i++) assert.equal(await periodic[reader](fullId,i),words[i]);
      await assert.rejects(periodic[reader](fullId,words.length));
    }
    await assert.rejects(periodic.readNonbondedWord(id('unknown'),0));
    await assert.rejects(periodic.periodicInfo(id('unknown')));
    await assert.rejects(periodic.pageCount(fullId,2));
    await assert.rejects(periodic.pageInfo(fullId,0,pages[0].length));
  });

  await t.test('independently reconstructs page, stream, configuration and transitive dataset commitments', async () => {
    const coder=AbiCoder.defaultAbiCoder();
    const hash=(types,values)=>keccak256(coder.encode(types,values));
    const streamHashes=[];
    for(let s=0;s<2;s++){
      let streamHash=hash(['bytes32','uint256'],[roles[s],pages[s].length]),offset=0;
      for(let i=0;i<pages[s].length;i++){
        const page=pages[s][i],address=await page.getAddress(),count=Number(await page.wordCount()),capacity=await page.capacityWords();
        let digest=hash(['bytes32','bytes32','uint32'],[encodeBytes32String('ORVIA-DATA-PAGE-v1'),roles[s],capacity]);
        for(const word of sourceWords[s].slice(offset,offset+count))digest=hash(['bytes32','bytes32'],[digest,word]);
        offset+=count;
        assert.equal(await page.rollingDigest(),digest);
        const codeHash=keccak256(await provider.getCode(address));
        assert.deepEqual([...await periodic.pageInfo(fullId,s,i)],[address,codeHash,digest,BigInt(count)]);
        streamHash=hash(['bytes32','uint256','address','bytes32','uint32','bytes32'],[streamHash,i,address,codeHash,count,digest]);
      }
      assert.equal(offset,sourceWords[s].length);streamHashes.push(streamHash);
    }
    const dynamicsAddress=await dynamics.getAddress();
    const header=hash(['address','bytes32','bytes32','bytes32','uint32[5]'],[dynamicsAddress,keccak256(await provider.getCode(dynamicsAddress)),dynamicsId,(await dynamics.datasetInfo(dynamicsId)).commitment,[4,1,1,1,2]]);
    const configuration=hash(['bytes16[3]','bytes16','bytes16','bytes16'],[registration.box,q(2),q(3),q(1)]);
    const expected=hash(['bytes32','uint256','address','bytes32','bytes32','bytes32','bytes32[2]'],[id('ORVIA.PERIODIC.DATASET.v1'),31337,await periodic.getAddress(),fullId,header,configuration,streamHashes]);
    assert.equal((await periodic.datasetInfo(fullId)).commitment,expected);
  });

  await t.test('explicit source pairs cannot be silently combined with exhaustive periodic enumeration', async () => {
    const pairPage=await makePage(dynamics,id('ORVIA.PAIRS.v1'),[integer(0),integer(3),floating(.5),floating(.125),floating(-.25),floating(1)]);
    const withPair=id('dynamics-with-direct-pair');
    await transact(dynamics.registerDataset(withPair,{...dynamicsRegistration,pairPages:[await pairPage.getAddress()],pairCount:1}));
    await assert.rejects(transact(periodic.registerDataset(id('reject-ambiguous-pairs'),{...registration,dynamicsDatasetId:withPair})));
  });

  await t.test('accepts absent exceptions and keeps dataset identities and configuration immutable', async () => {
    const minimal={...registration,exceptionPages:[],exceptionCount:0};
    const minimalId=id('periodic-no-exceptions');
    await transact(periodic.registerDataset(minimalId,minimal));
    assert.equal(await periodic.pageCount(minimalId,1),0n);
    assert.equal((await periodic.periodicInfo(minimalId)).exceptionCount,0n);
    assert.equal((await periodic.datasetInfo(minimalId)).pairCount,6n);
    await assert.rejects(periodic.readExceptionWord(minimalId,0));
    await assert.rejects(transact(periodic.registerDataset(minimalId,{...minimal,cutoff:q(2.5)})));
    const otherId=id('same-periodic-input-new-id');
    await transact(periodic.registerDataset(otherId,minimal));
    assert.notEqual((await periodic.datasetInfo(otherId)).commitment,(await periodic.datasetInfo(minimalId)).commitment);
    await assert.rejects(transact(periodic.registerDataset(id('empty-nonzero-exceptions'),{...minimal,exceptionCount:1})));
    await assert.rejects(transact(periodic.registerDataset(id('nonempty-zero-exceptions'),{...minimal,exceptionPages:addresses[1]})));
  });

  await t.test('rejects invalid periodic domains and handles binary128 doubling exactly at subnormal boundaries', async () => {
    const nan='0x7fff8000000000000000000000000000',inf='0x7fff0000000000000000000000000000';
    const bad=[{switchDistance:q(0)},{switchDistance:q(3)},{switchDistance:q(-1)},{switchDistance:nan},
      {cutoff:q(0)},{cutoff:q(-3)},{cutoff:inf},{cutoff:nan},{cutoff:q(4)},
      {box:[q(6),q(10),q(12)]},{box:[q(0),q(10),q(12)]},{box:[q(-8),q(10),q(12)]},
      {box:[q(8),inf,q(12)]},{box:[q(8),q(10),nan]},{prefactor:q(-1)},{prefactor:inf},{prefactor:nan},
      {cutoff:'0x7ffe0000000000000000000000000000',box:Array(3).fill('0x7ffeffffffffffffffffffffffffffff')}];
    for(const override of bad)await assert.rejects(transact(periodic.registerDataset(id(`bad-periodic-config-${++sequence}`),{...registration,...override})));
    const tiny={...registration,switchDistance:rawQuad(1),cutoff:rawQuad(2),box:Array(3).fill(rawQuad(5)),prefactor:q(0)};
    const tinyId=id('subnormal-config-exact-doubling');
    await transact(periodic.registerDataset(tinyId,tiny));
    assert.equal((await periodic.periodicInfo(tinyId)).cutoff,rawQuad(2));
    await assert.rejects(transact(periodic.registerDataset(id('subnormal-half-equality'),{...tiny,box:Array(3).fill(rawQuad(4))})));
    const boundary=1n<<112n;
    const crossing={...tiny,cutoff:rawQuad(boundary-1n),box:Array(3).fill(rawQuad(2n*boundary-1n))};
    await transact(periodic.registerDataset(id('subnormal-normal-crossing'),crossing));
    await assert.rejects(transact(periodic.registerDataset(id('subnormal-normal-half-equality'),{...crossing,box:Array(3).fill(rawQuad(2n*boundary-2n))})));
  });

  await t.test('enforces owner, factory, role, sealing, coverage and page bounds with atomic failure/retry', async () => {
    await assert.rejects(transact(periodic.connect(contributor).createPage(roles[0],1)));
    await assert.rejects(transact(periodic.createPage(id('invalid-periodic-role'),1)));
    await assert.rejects(transact(periodic.connect(contributor).registerDataset(id('wrong-periodic-owner'),registration)));
    await assert.rejects(transact(periodic.registerDataset(ZeroHash,registration)));
    await assert.rejects(transact(periodic.registerDataset(id('unknown-periodic-parent'),{...registration,dynamicsDatasetId:id('missing')})));
    await assert.rejects(transact(periodic.registerDataset(id('too-many-exceptions'),{...registration,exceptionCount:4097})));
    await assert.rejects(transact(periodic.registerDataset(id('more-exceptions-than-pairs'),{...registration,exceptionCount:7})));
    await assert.rejects(transact(periodic.registerDataset(id('too-many-periodic-pages'),{...registration,nonbondedPages:Array(17).fill(addresses[0][0])})));
    await assert.rejects(transact(periodic.registerDataset(id('duplicate-periodic-page'),{...registration,nonbondedPages:[addresses[0][0],addresses[0][0]]})));
    await assert.rejects(transact(periodic.registerDataset(id('cross-stream-periodic-page'),{...registration,exceptionPages:[addresses[0][0]]})));
    await assert.rejects(transact(periodic.registerDataset(id('wrong-periodic-role'),{...registration,nonbondedPages:addresses[1]})));
    const unsealed=await makePage(periodic,roles[0],sourceWords[0],false);
    await assert.rejects(transact(periodic.registerDataset(id('unsealed-periodic-page'),{...registration,nonbondedPages:[await unsealed.getAddress()]})));
    const external=await deploy('DataPage',owner,[ownerAddress,roles[0],sourceWords[0].length]);
    await transact(external.append(sourceWords[0]));await transact(external.seal(await external.rollingDigest()));
    await assert.rejects(transact(periodic.registerDataset(id('untrusted-periodic-page'),{...registration,nonbondedPages:[await external.getAddress()]})));
    const retried=id('periodic-retry-after-revert');
    await assert.rejects(transact(periodic.registerDataset(retried,{...registration,exceptionCount:3},{gasLimit:12000000})));
    await assert.rejects(periodic.datasetInfo(retried));
    await transact(periodic.registerDataset(retried,registration));
    assert.equal((await periodic.datasetInfo(retried)).dynamicsDatasetId,dynamicsId);
    await assert.rejects(transact(pages[0][0].append([floating(1)])));
  });

  await t.test('schema width follows each global field across pages; numeric validity remains staged', async () => {
    for(const [key,stream,index,width] of [['nonbondedPages',0,4,128],['exceptionPages',1,2,32],['exceptionPages',1,4,128]]){
      const words=[...sourceWords[stream]];words[index]=integer(BigInt(words[index])|(1n<<BigInt(width)));
      const dirty=await makeStream(roles[stream],words,[index]);
      const dirtyId=id(`dirty-periodic-${++sequence}`);
      await transact(periodic.registerDataset(dirtyId,{...registration,[key]:await Promise.all(dirty.map(p=>p.getAddress()))}));
      await assert.rejects(periodic[stream?'readExceptionWord':'readNonbondedWord'](dirtyId,index));
    }
    const words=[...sourceWords[0]];words[0]=zeroPadValue('0x7fff8000000000000000000000000000',32);
    const rawPage=await makePage(periodic,roles[0],words),rawId=id('raw-periodic-nan');
    await transact(periodic.registerDataset(rawId,{...registration,nonbondedPages:[await rawPage.getAddress()]}));
    assert.equal(await periodic.readNonbondedWord(rawId,0),words[0]);
    // Kind and atom bounds are canonical uint32 but semantic checks belong to the resumable coordinator.
    const malformed=[...sourceWords[1]];malformed[1]=integer(99);malformed[2]=integer(3);
    const badSemanticPage=await makePage(periodic,roles[1],malformed),semanticId=id('raw-periodic-bad-semantics');
    await transact(periodic.registerDataset(semanticId,{...registration,exceptionPages:[await badSemanticPage.getAddress()]}));
    assert.equal(await periodic.readExceptionWord(semanticId,1),integer(99));
  });

  await t.test('detects altered transitive code and parameter-page code before asserting dataset integrity', async () => {
    for(const address of [await dynamics.getAddress(),await base.getAddress(),await basePositions.getAddress(),await pages[0][0].getAddress()]){
      const snapshot=await transport.request({method:'evm_snapshot',params:[]});
      try{
        await transport.request({method:'evm_setAccountCode',params:[address,'0x00']});
        await assert.rejects(periodic.assertDataset(fullId));
      }finally{await transport.request({method:'evm_revert',params:[snapshot]});}
      assert.equal(await periodic.assertDataset(fullId),(await periodic.datasetInfo(fullId)).commitment);
    }
  });
});
