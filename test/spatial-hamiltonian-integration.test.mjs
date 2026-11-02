import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),outDir=path.join(root,'reports');
const require=createRequire(path.join(root,'package.json'));
const solc=require('solc'),ganache=require('ganache');
const{BrowserProvider,ContractFactory,id,toBeHex,zeroPadValue,ZeroHash}=require('ethers');
const sha=x=>createHash('sha256').update(x).digest('hex');
const plain=x=>Array.isArray(x)?Array.from(x,plain):x;
const gasLimit=28_000_000,word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
function q(x){
 assert(Number.isFinite(x));const b=Buffer.alloc(8);b.writeDoubleBE(x);const bits=b.readBigUInt64BE(),sign=bits>>63n,e=(bits>>52n)&2047n,f=bits&((1n<<52n)-1n);
 let result;if(e===0n){if(f===0n)result=sign<<127n;else{const top=BigInt(f.toString(2).length-1);result=(sign<<127n)|((top-1074n+16383n)<<112n)|((f-(1n<<top))<<(112n-top));}}
 else result=(sign<<127n)|((e-1023n+16383n)<<112n)|(f<<60n);return toBeHex(result,16);
}
const qvec=x=>x.map(q),copy=x=>JSON.parse(JSON.stringify(x));
const sourceRoot='contracts/core/AlchemicalHamiltonianEvaluator.sol',legacyRoot='contracts/core/AlchemicalHamiltonianEvaluatorLegacy.sol';
function compile(){
 const sources={},physical={};
 function add(file){if(sources[file])return;const location=file===legacyRoot?path.join(root,'test/fixtures/spatial-hamiltonian/AlchemicalHamiltonianEvaluator.baseline.sol'):path.join(root,file);const content=fs.readFileSync(location,'utf8');sources[file]={content};physical[file]=location;for(const m of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])));}
 for(const file of [sourceRoot,legacyRoot,'contracts/core/BankedInputCatalog.sol','contracts/core/BankedWorkingState.sol','contracts/math/ScalarMath.sol','contracts/math/ElementaryMath.sol','test/contracts/WorkingStateWriterHarness.sol'])add(file);
 const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}};
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');
 const input={language:'Solidity',sources,settings},output=JSON.parse(solc.compile(JSON.stringify(input))),errors=output.errors?.filter(x=>x.severity==='error')??[];
 assert.equal(errors.length,0,errors.map(x=>x.formattedMessage).join('\n'));
 const artifacts={};for(const[file,contracts]of Object.entries(output.contracts))for(const[name,c]of Object.entries(contracts)){const a={abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,runtime:'0x'+c.evm.deployedBytecode.object};artifacts[file===legacyRoot&&name==='AlchemicalHamiltonianEvaluator'?'LegacyHamiltonian':name]=a;}
 fs.writeFileSync(path.join(outDir,'spatial_hamiltonian_standard_input.json'),JSON.stringify(input,null,2)+'\n');
 return{artifacts,physical,evidence:{compiler:solc.version(),settings,standardInputSha256:sha(JSON.stringify(input)),sourceSha256:Object.fromEntries(Object.entries(sources).map(([p,s])=>[p,sha(s.content)]))}};
}
function simple(positions,overrides={}){
 const n=positions.length,a={particles:Array.from({length:n},()=>qvec([1,0,0,0])),nonbonded:Array.from({length:n},()=>qvec([.5,.125,0])),bonds:[],angles:[],torsions:[],exceptions:[]};
 return{positions:positions.map(p=>p.map(x=>typeof x==='number'?q(x):x)),a,b:copy(a),box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),alpha:q(.75),extent:1,softcoreAlpha:q(.5),...overrides};
}
function mixed(){const p=JSON.parse(fs.readFileSync(path.join(root,'reference/periodic_reference.json'))).inputs;
 const a={particles:p.particles,nonbonded:p.nonbonded,bonds:p.bonds,angles:p.angles,torsions:p.torsions,exceptions:p.exceptions},b=copy(a);
 b.bonds[0][2]=q(3);b.angles[0][3]=q(.75);b.torsions[0][5]=q(.375);b.nonbonded[0]=[q(.625),q(.1875),q(.25)];b.nonbonded[3][2]=q(-.125);b.exceptions[1][4]=q(.09375);b.exceptions[1][5]=q(-.0625);
 return{positions:p.positions,a,b,box:p.box,switchDistance:p.switchDistance,cutoff:p.cutoff,prefactor:p.prefactor,alpha:q(.75),extent:1,softcoreAlpha:q(.5)};}

test('isolated spatial Hamiltonian preserves complete result words and legacy fallback',async t=>{
 const report={schemaVersion:1,status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'Isolated candidate full-Hamiltonian parity and measured traversal work. Not canonical integration, full prepared myosin, ensemble acceptance or target-chain gas.',
  testSourceSha256:sha(fs.readFileSync(import.meta.filename)),baselineModuleOrigin:'canonical validated cutoff module copied at parent HEAD da22269921e870a568d0c77ce8bc4174907c5f2e',
  localChain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},cases:[]};
 const save=()=>fs.writeFileSync(path.join(outDir,'spatial_hamiltonian_validation.json'),JSON.stringify(report,null,2)+'\n');save();
 try{
  const{artifacts,physical,evidence}=compile();report.compilation=evidence;
  const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
  t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
  const owner=await provider.getSigner(0),ownerAddress=await owner.getAddress();
  const send=async p=>(await p).wait();
  async function deploy(name,args=[]){const a=artifacts[name];assert(a,'Missing in-memory fixture artifact '+name);const c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args);await c.waitForDeployment();return c;}
  const writer=await deploy('WorkingStateWriterHarness');
  const math=await deploy('FloatMath'),scalar=await deploy('ScalarMath',[math.target]),elementary=await deploy('ElementaryMath',[math.target]);
  const registry=await deploy('ExperimentRegistry',[ownerAddress]),geometry=await deploy('OrthorhombicGeometry',[math.target]);
  const bond=await deploy('HarmonicBondKernel',[math.target]),angle=await deploy('HarmonicAngleKernel',[math.target,elementary.target]),torsion=await deploy('PeriodicTorsionKernel',[math.target,elementary.target]);
  const lj=await deploy('LennardJonesKernel',[math.target]),softcore=await deploy('SoftcoreLennardJonesKernel',[math.target]);
  const realSpace=await deploy('EwaldRealSpaceKernel',[math.target,scalar.target]),reciprocal=await deploy('EwaldReciprocalKernel',[math.target,scalar.target,elementary.target]),corrections=await deploy('EwaldCorrections',[math.target,scalar.target]);
  const inputs=await deploy('BankedInputCatalog',[ownerAddress]);while(await inputs.bankCount()<96n)await send(inputs.createBanks(4,{gasLimit}));
  const topology=await deploy('AlchemicalTopologyCatalog',[ownerAddress,inputs.target,math.target,geometry.target]);
  const modules=Object.fromEntries(Object.entries({registry,topology,math,geometry,bond,angle,torsion,lj,softcore,realSpace,reciprocal,corrections}).map(([k,c])=>[k,c.target]));
  const legacy=await deploy('LegacyHamiltonian',[writer.target,modules]),spatial=await deploy('AlchemicalHamiltonianEvaluator',[writer.target,modules]);
  const source=await deploy('BankedWorkingState',[writer.target,2]),legacyOutput=await deploy('BankedWorkingState',[legacy.target,2]),spatialOutput=await deploy('BankedWorkingState',[spatial.target,2]);
  for(const s of[source,legacyOutput,spatialOutput])await send(s.deployBanks(2,{gasLimit}));
  const forward=(c,name,args)=>writer.forward(c.target,c.interface.encodeFunctionData(name,args),{gasLimit});
  await send(forward(legacy,'bindOutputPage',[legacyOutput.target]));await send(forward(spatial,'bindOutputPage',[spatialOutput.target]));
  const cells=await deploy('PeriodicCellIndex',[spatial.target,registry.target,math.target,geometry.target]),pairs=await deploy('OrderedNeighborPairs',[spatial.target,cells.target]);
  await send(forward(spatial,'bindSpatial',[cells.target,pairs.target]));
  const protocol=id('isolated-spatial-full-H-parity');await send(registry.registerProtocol(protocol,id('source-bound candidate parity fixtures; not scientific acceptance'),[...new Set([...Object.values(modules),scalar.target,elementary.target,inputs.target,writer.target,source.target,legacy.target,spatial.target,legacyOutput.target,spatialOutput.target,cells.target,pairs.target])]));
  let serial=0;
  async function stream(role,values){if(!values.length)return ZeroHash;const name=id('spatial-stream-'+ ++serial);await send(inputs.beginStream(name,id(role),values.length));for(let i=0;i<values.length;i+=128)await send(inputs.appendWords(name,values.slice(i,i+128).map(word),{gasLimit}));await send(inputs.sealStream(name));return name;}
  async function fixture(f){const endpoint=async e=>({particles:await stream('PARTICLES',e.particles.flat()),nonbonded:await stream('NONBONDED',e.nonbonded.flat()),bonds:await stream('BONDS',e.bonds.flat()),angles:await stream('ANGLES',e.angles.flat()),torsions:await stream('TORSIONS',e.torsions.flat()),exceptions:await stream('EXCEPTIONS',e.exceptions.flat())});
   const d={modelPolicy:id('isolated finite Hamiltonian parity'),dummyPolicy:id('all fixture atoms physical'),positions:await stream('POSITIONS',f.positions.flat()),a:await endpoint(f.a),b:await endpoint(f.b),atoms:f.positions.length,bonds:f.a.bonds.length,angles:f.a.angles.length,torsions:f.a.torsions.length,exceptions:f.a.exceptions.length,box:f.box,switchDistance:f.switchDistance,cutoff:f.cutoff,prefactor:f.prefactor,ewaldAlpha:f.alpha,ewaldExtent:f.extent,softcoreAlpha:f.softcoreAlpha};
   const tid=id('spatial-topology-'+ ++serial);await send(topology.create(tid,d,[q(0),q(.5),q(1)],{gasLimit}));for(let n=0;n<1000;++n){if((await topology.info(tid)).stage===6n)break;await send(topology.advance(tid,8,{gasLimit}));}
   assert.equal((await topology.info(tid)).stage,6n);
   const ns=id('spatial-frame-'+ ++serial),snap=id('spatial-frozen-'+serial),values=f.positions.flat().map(word);
   await send(forward(source,'createNamespace',[ns,values.length]));for(let i=0;i<values.length;i+=128)await send(forward(source,'writeWords',[ns,i,values.slice(i,i+128)]));await send(forward(source,'snapshotNamespace',[ns,snap]));
   return{tid,snap,f};
  }
  async function register(h,fx,state=1){const evalId=await h.nextEvaluation();await send(forward(h,'registerEvaluation',[protocol,fx.tid,state,source.target,fx.snap,0,3]));return evalId;}
  async function advance(h,evalId,work=8){const before=(await h.runInfo(evalId)).stage,receipt=await send(h.advance(evalId,work,{gasLimit}));return{stage:Number(before),gasUsed:String(receipt.gasUsed),work};}
  async function finish(h,evalId,atoms,schedule=[8]){const gas=[];for(let n=0;n<10000;++n){if((await h.runInfo(evalId)).stage===11n){const components=[...await h.components(evalId)],forces=[];for(let a=0;a<atoms;++a)forces.push([...await h.forceAt(evalId,a)]);return{components,forces,energy:(await h.result(evalId)).energy,gas,totalAdvanceGas:gas.reduce((s,x)=>s+BigInt(x.gasUsed),0n).toString()};}gas.push(await advance(h,evalId,schedule[n%schedule.length]));}assert.fail('evaluation did not finish');}
  function equal(a,b){assert.deepEqual(a.components,b.components);assert.deepEqual(a.forces,b.forces);assert.equal(a.energy,b.energy);}
  let successful=0;
  await t.test('mixed charged hybrid bonded/angle/torsion/exception and complete finite Ewald words match',async()=>{
   const f=mixed(),fx=await fixture(f),a=await register(legacy,fx),b=await register(spatial,fx);
   const baseline=await finish(legacy,a,f.positions.length),candidate=await finish(spatial,b,f.positions.length,[1,8,3]);equal(baseline,candidate);
   const info=plain(await spatial.spatialInfo(b));assert.equal(info[1],true);
   report.cases.push({name:'mixed charged interior lambda',lambda:q(.5),atoms:f.positions.length,comparedWords:11+3*f.positions.length,exactAllEnergyForceWords:true,spatialInfo:info.map(x=>typeof x==='bigint'?String(x):x),baseline,candidate});save();++successful;
  });
  await t.test('cutoff-adjacent binary128 words retain exact force/energy results',async()=>{
   const radius=q(3),f=simple([[0,0,0],[toBeHex(BigInt(radius)-1n,16),0,0],[radius,0,0],[toBeHex(BigInt(radius)+1n,16),0,0]]),fx=await fixture(f);
   const a=await register(legacy,fx,0),b=await register(spatial,fx,0),baseline=await finish(legacy,a,4),candidate=await finish(spatial,b,4);equal(baseline,candidate);
   report.cases.push({name:'cutoff +/-binary128 adjacent value',exactAllEnergyForceWords:true,baseline,candidate});save();++successful;
  });
  await t.test('unsupported cutoff/translation values use exact all-pairs fallback without new rejection',async()=>{
   const tiny=simple([[0,0,0],[1,0,0]],{switchDistance:q(2**-66),cutoff:q(2**-65)});
   const translated=simple([[2**34,0,0],[2**34+1,0,0]]);
   for(const[name,f]of [['cutoff below cell domain',tiny],['common unwrapped translation beyond cell domain',translated]]){
    const fx=await fixture(f),a=await register(legacy,fx),b=await register(spatial,fx),baseline=await finish(legacy,a,2),candidate=await finish(spatial,b,2);equal(baseline,candidate);
    const info=await spatial.spatialInfo(b);assert.equal(info.used,false);assert.equal(info.legacyVisits,1n);assert.equal(info.candidateVisits,0n);
    report.cases.push({name,exactAllEnergyForceWords:true,fallbackLegacyVisits:String(info.legacyVisits),baseline,candidate});save();
   }++successful;
  });
  await t.test('unsafe finite parameter products retain the original failure before cutoff',async()=>{
   const f=simple([[0,0,0],[3.5,0,0]]),huge=toBeHex(BigInt(16383+9000)<<112n,16);
   for(const endpoint of[f.a,f.b])for(const p of endpoint.nonbonded)p[1]=huge;
   const fx=await fixture(f),a=await register(legacy,fx),b=await register(spatial,fx);
   for(const[h,n]of[[legacy,a],[spatial,b]]){
    for(let i=0;i<100;++i){if((await h.runInfo(n)).stage===6n)break;await advance(h,n,1);}
    assert.equal((await h.runInfo(n)).stage,6n);await assert.rejects(h.advance.staticCall(n,1),e=>e.data===math.interface.getError('NonFinite').selector);
   }
   assert.equal((await spatial.spatialInfo(b)).used,false);report.cases.push({name:'finite epsilon product overflow outside cutoff',sameLegacyNonFiniteRevert:true});save();++successful;
  });
  await t.test('real sparse pair work is reduced while an uncut distant exception is preserved',async()=>{
   const f=simple(Array.from({length:16},(_,a)=>[-30+4*a,0,0]),{box:qvec([128,128,128]),switchDistance:q(.9),cutoff:q(1)});
   f.a.exceptions=[[0,15,2,q(.5),q(.125),q(0)]];f.b.exceptions=copy(f.a.exceptions);
   const fx=await fixture(f),a=await register(legacy,fx),b=await register(spatial,fx),baseline=await finish(legacy,a,16),candidate=await finish(spatial,b,16);equal(baseline,candidate);
   const info=await spatial.spatialInfo(b);assert.equal(info.used,true);assert(info.candidateVisits<120n);assert.notEqual(candidate.energy,q(0));
   report.cases.push({name:'16 atom sparse LJ with distant uncut exception',exactAllEnergyForceWords:true,legacyUnorderedPairVisits:120,spatialCandidateVisits:String(info.candidateVisits),
    advancementGasSaving:String(BigInt(baseline.totalAdvanceGas)-BigInt(candidate.totalAdvanceGas)),baseline,candidate});save();++successful;
  });
  assert.equal(successful,5);for(const[file,hash]of Object.entries(evidence.sourceSha256))assert.equal(sha(fs.readFileSync(physical[file])),hash);
  assert.equal(sha(fs.readFileSync(import.meta.filename)),report.testSourceSha256);report.passed=true;report.status='passed';
 }finally{save();}
});
