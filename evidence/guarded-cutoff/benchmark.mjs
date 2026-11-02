import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const OUT=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(OUT,'../..');
const require=createRequire(path.join(ROOT,'ORVIA/package.json'));
const solc=require('solc'),ganache=require('ganache');
const {BrowserProvider,Contract,ContractFactory,AbiCoder,id,keccak256,toBeHex,zeroPadValue,ZeroHash,encodeBytes32String}=require('ethers');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const q=x=>{const b=Buffer.alloc(8);b.writeDoubleBE(x);const u=b.readBigUInt64BE(),s=u>>63n,e=(u>>52n)&2047n,f=u&((1n<<52n)-1n);let v;if(!e){if(!f)v=s<<127n;else{const t=BigInt(f.toString(2).length-1);v=(s<<127n)|((t-1074n+16383n)<<112n)|((f-(1n<<t))<<(112n-t));}}else v=(s<<127n)|((e-1023n+16383n)<<112n)|(f<<60n);return toBeHex(v,16);};
const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const gasLimit=29_000_000n,TARGET='contracts/core/AlchemicalHamiltonianEvaluator.sol';
const preparation=JSON.parse(fs.readFileSync(path.join(OUT,'candidate-preparation.json')));
const report={schema:'orvia.guarded-cutoff-real-evaluator-benchmark.v1',status:'in_progress',passed:false,canonicalModified:false,
 scope:'Real sealed input catalog, COW source snapshot, actual baseline/candidate Hamiltonian and output storage on local Shanghai EVM. Native16 outside-only gas fixture is not a full protein measurement or target fee.',
 preparation,compiler:null,compilation:{passed:false},native:[],cases:[],failures:[],mainnetTransactionsSent:0,scientificAcceptance:false};
const save=()=>fs.writeFileSync(path.join(OUT,'benchmark-report.json'),JSON.stringify(report,null,2)+'\n');save();
const harness=`// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShardedWorkingState} from "contracts/core/ShardedWorkingState.sol";
contract CutoffSnapshotWriter {
 address public immutable owner; ShardedWorkingState public state;
 constructor(){owner=msg.sender;}
 function bind(address page) external {require(msg.sender==owner&&address(state)==address(0));state=ShardedWorkingState(page);require(state.writer()==address(this));}
 function load(bytes32 ns,bytes32 snap,bytes32[] calldata values) external {require(msg.sender==owner);state.createNamespace(ns,uint32(values.length));
  for(uint256 start;start<values.length;start+=128){uint256 count=values.length-start;if(count>128)count=128;bytes32[] memory chunk=new bytes32[](count);for(uint256 k;k<count;++k)chunk[k]=values[start+k];state.writeWords(ns,start,chunk);}
  state.snapshotNamespace(ns,snap);
 }
}`;
fs.writeFileSync(path.join(OUT,'CutoffSnapshotWriter.sol'),harness);

function compile(candidate){
 const sources=JSON.parse(fs.readFileSync(path.join(OUT,'baseline-sources.json')));
 if(candidate)sources[TARGET].content=fs.readFileSync(path.join(OUT,'AlchemicalHamiltonianEvaluator.candidate.sol'),'utf8');
 sources['CutoffSnapshotWriter.sol']={content:harness};
 const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(input)));
 const errors=(output.errors??[]).filter(x=>x.severity==='error');if(errors.length)throw new Error(errors.map(x=>x.formattedMessage).join('\n'));
 const artifacts={};for(const contracts of Object.values(output.contracts))for(const[name,a]of Object.entries(contracts))if(a.evm.bytecode.object)artifacts[name]=a;
 return{artifacts,inputSha256:sha(JSON.stringify(input)),warnings:(output.errors??[]).map(x=>x.formattedMessage)};
}

let raw;
try{
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');report.compiler=solc.version();
 const baseline=compile(false),candidate=compile(true);
 report.compilation={passed:true,baselineInputSha256:baseline.inputSha256,candidateInputSha256:candidate.inputSha256,
  baselineRuntimeBytes:baseline.artifacts.AlchemicalHamiltonianEvaluator.evm.deployedBytecode.object.length/2,
  candidateRuntimeBytes:candidate.artifacts.AlchemicalHamiltonianEvaluator.evm.deployedBytecode.object.length/2,
  warnings:[...baseline.warnings,...candidate.warnings]};save();
 if(process.argv.includes('--compile-only')){report.status='compiled_not_benchmarked';save();process.exit(0);}
 raw=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:2}});
 const provider=new BrowserProvider(raw);provider.pollingInterval=5;
 const owner=await provider.getSigner(0),ownerAddress=await owner.getAddress();
 const tx=async p=>(await p).wait();
 const deploy=async(name,args=[],variant=baseline)=>{const a=variant.artifacts[name];const c=await new ContractFactory(a.abi,'0x'+a.evm.bytecode.object,owner).deploy(...args,{gasLimit});await c.waitForDeployment();return c;};
 const math=await deploy('FloatMath'),ma=await math.getAddress();
 const scalar=await deploy('ScalarMath',[ma]),elementary=await deploy('ElementaryMath',[ma]);
 const registry=await deploy('ExperimentRegistry',[ownerAddress]),geometry=await deploy('OrthorhombicGeometry',[ma]);
 const bond=await deploy('HarmonicBondKernel',[ma]),angle=await deploy('HarmonicAngleKernel',[ma,await elementary.getAddress()]);
 const torsion=await deploy('PeriodicTorsionKernel',[ma,await elementary.getAddress()]),lj=await deploy('LennardJonesKernel',[ma]);
 const softcore=await deploy('SoftcoreLennardJonesKernel',[ma]),realSpace=await deploy('EwaldRealSpaceKernel',[ma,await scalar.getAddress()]);
 const reciprocal=await deploy('EwaldReciprocalKernel',[ma,await scalar.getAddress(),await elementary.getAddress()]);
 const corrections=await deploy('EwaldCorrections',[ma,await scalar.getAddress()]);
 const inputs=await deploy('PartitionedInputCatalog',[ownerAddress]);
 const topology=await deploy('AlchemicalTopologyCatalog',[ownerAddress,await inputs.getAddress(),ma,await geometry.getAddress()]);
 const writer=await deploy('CutoffSnapshotWriter'),source=await deploy('ShardedWorkingState',[await writer.getAddress()]);await tx(writer.bind(await source.getAddress(),{gasLimit}));
 const modules={registry:await registry.getAddress(),topology:await topology.getAddress(),math:ma,geometry:await geometry.getAddress(),
  bond:await bond.getAddress(),angle:await angle.getAddress(),torsion:await torsion.getAddress(),lj:await lj.getAddress(),softcore:await softcore.getAddress(),
  realSpace:await realSpace.getAddress(),reciprocal:await reciprocal.getAddress(),corrections:await corrections.getAddress()};
 const hb=await deploy('AlchemicalHamiltonianEvaluator',[ownerAddress,modules],baseline),hc=await deploy('AlchemicalHamiltonianEvaluator',[ownerAddress,modules],candidate);
 const ob=await deploy('ShardedWorkingState',[await hb.getAddress()]),oc=await deploy('ShardedWorkingState',[await hc.getAddress()]);
 await tx(hb.bindOutputPage(await ob.getAddress(),{gasLimit}));await tx(hc.bindOutputPage(await oc.getAddress(),{gasLimit}));
 const protocol=id('ORVIA isolated guarded cutoff parity; no scientific acceptance');
 const registered=[...Object.values(modules),await inputs.getAddress(),await scalar.getAddress(),await elementary.getAddress(),await writer.getAddress(),await source.getAddress(),await hb.getAddress(),await hc.getAddress(),await ob.getAddress(),await oc.getAddress()];
 await tx(registry.registerProtocol(protocol,id('Frozen baseline and candidate pair parity'),[...new Set(registered)],{gasLimit}));
 report.runtime={chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true,baselineEvaluator:await hb.getAddress(),candidateEvaluator:await hc.getAddress(),
  baselineRuntimeKeccak256:keccak256(await provider.getCode(await hb.getAddress())),candidateRuntimeKeccak256:keccak256(await provider.getCode(await hc.getAddress()))};save();
 let serial=0;
 async function stream(role,values){
  if(!values.length)return ZeroHash;const sid=id('isolated-stream-'+(++serial)),rid=id(role);await tx(inputs.beginStream(sid,rid,values.length,{gasLimit}));
  for(let start=0;start<values.length;start+=4096){const valuesHere=values.slice(start,start+4096),receipt=await tx(inputs.createPage(rid,valuesHere.length,{gasLimit}));
   const event=receipt.logs.map(l=>{try{return inputs.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='PageCreated');const page=new Contract(event.args.page,baseline.artifacts.DataPage.abi,owner);
   for(let k=0;k<valuesHere.length;k+=128)await tx(page.append(valuesHere.slice(k,k+128).map(word),{gasLimit}));await tx(page.seal(await page.rollingDigest(),{gasLimit}));await tx(inputs.appendPage(sid,await page.getAddress(),{gasLimit}));}
  await tx(inputs.sealStream(sid,{gasLimit}));return sid;
 }
 async function setupFixture(f,lambdas){
  const endpoint=async e=>({particles:await stream('PARTICLES',e.particles.flat()),nonbonded:await stream('NONBONDED',e.nonbonded.flat()),bonds:await stream('BONDS',e.bonds.flat()),angles:await stream('ANGLES',e.angles.flat()),torsions:await stream('TORSIONS',e.torsions.flat()),exceptions:await stream('EXCEPTIONS',e.exceptions.flat())});
  const d={modelPolicy:id('Parameter provenance fixture; not an accepted molecule'),dummyPolicy:id('Test explicit endpoint semantics'),positions:await stream('POSITIONS',f.positions.flat()),a:await endpoint(f.a),b:await endpoint(f.b),atoms:f.positions.length,bonds:f.a.bonds.length,angles:f.a.angles.length,torsions:f.a.torsions.length,exceptions:f.a.exceptions.length,box:f.box,switchDistance:f.switchDistance,cutoff:f.cutoff,prefactor:f.prefactor,ewaldAlpha:f.alpha,ewaldExtent:f.extent,softcoreAlpha:f.softcoreAlpha};
  const topologyId=id('isolated-topology-'+(++serial));await tx(topology.create(topologyId,d,lambdas,{gasLimit}));
  for(let i=0;i<1000&&(await topology.info(topologyId)).stage!==6n;++i)await tx(topology.advance(topologyId,8,{gasLimit}));assert.equal((await topology.info(topologyId)).stage,6n);
  const ns=id('isolated-source-'+(++serial)),snapshot=id('isolated-snapshot-'+serial);await tx(writer.load(ns,snapshot,f.positions.flat().map(word),{gasLimit}));return{topologyId,snapshot,atoms:d.atoms};
 }
 function errorData(e){return typeof e?.data==='string'?e.data:typeof e?.info?.error?.data?.result==='string'?e.info.error.data.result:null;}
 async function evaluate(h,output,fixture,state,work,native=false){
  const evaluation=await h.nextEvaluation();await tx(h.registerEvaluation(protocol,fixture.topologyId,state,await source.getAddress(),fixture.snapshot,0,3,{gasLimit}));
  const trace=[],receipts=[];let rejected=null;
  for(let i=0;i<10000;++i){const before=await h.runInfo(evaluation);const stage=Number(before.stage);if(stage===11)break;
   trace.push([stage,String(before.cursor),String(before.mode)]);const batch=native&&stage<6?1:work;
   try{const receipt=await tx(h.advance(evaluation,batch,{gasLimit}));receipts.push({stage,cursor:String(before.cursor),work:batch,gas:String(receipt.gasUsed)});}
   catch(e){let data=null;try{await h.advance.staticCall(evaluation,batch)}catch(probe){data=errorData(probe)}rejected={stage,cursor:String(before.cursor),data,txCode:e.code};break;}
   if(i===9999)throw new Error('Evaluation did not terminate');
  }
  const namespace=keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32','uint256','address','uint256'],[encodeBytes32String('ORVIA-HAMILTONIAN-OUTPUT-v1'),31337,await h.getAddress(),evaluation]));
  const words=[...await output.readWords(namespace,0,fixture.atoms*3+10)];
  const complete=(await h.runInfo(evaluation)).stage===11n;
  return{evaluation:String(evaluation),complete,rejected,trace,receipts,words};
 }
 async function compareFixture(name,f,lambdas,states,work=8,native=false){
  const fixture=await setupFixture(f,lambdas),runs=[];
  for(const state of states){const a=await evaluate(hb,ob,fixture,state,work,native),b=await evaluate(hc,oc,fixture,state,work,native);
   assert.deepEqual(a.trace,b.trace,name+' stage/cursor/mode order');assert.equal(a.complete,b.complete,name+' completion');assert.deepEqual(a.rejected,b.rejected,name+' failure selector/stage');assert.deepEqual(a.words,b.words,name+' every raw component/force word');
   runs.push({state,baseline:a,candidate:b,exactWordsCompared:a.words.length,passed:true});}
  return{name,atoms:fixture.atoms,work,runs,passed:true};
 }
 const nativePath=path.join(ROOT,'output/gas-estimate/outside-pair-input.json'),native=JSON.parse(fs.readFileSync(nativePath));
 const particles=native.particles.map(p=>[q(p[3]),q(0),q(0),q(0)]),nonbonded=native.particles.map(p=>[q(p[1]>0?p[1]:1),q(p[2]),q(p[0])]);
 const endpoint={particles,nonbonded,bonds:[],angles:[],torsions:[],exceptions:[]};
 const nativeSource={positions:native.positions.map(v=>v.map(q)),a:endpoint,b:endpoint,box:native.box.map(q),switchDistance:q(.9),cutoff:q(1),prefactor:q(138.93545764438198),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
 report.nativeInput={path:nativePath,sha256:sha(fs.readFileSync(nativePath)),sourceSha256:native.sourceSha256,globalIndices:native.globalIndices,
  sigmaNormalization:'Only native sigma<=0 with exact epsilon0 is represented by inert1nm to meet existing positive-sigma catalog ABI; this is explicit in the original gas input.',minimumSeparationNm:native.minimumPairSeparationNm};save();
 for(const work of[1,8]){const r=await compareFixture('native16-outside-work'+work,nativeSource,[q(0),q(1)],[0],work,true);report.native.push(r);save();console.log(JSON.stringify({nativeWork:work,passed:true}));}
 if(!process.argv.includes('--native-only')){
  const casePath=path.join(OUT,'cases/cases.json');const packet=JSON.parse(fs.readFileSync(casePath));report.caseInputSha256=sha(fs.readFileSync(casePath));
  for(const c of packet.cases){const lambdas=c.lambdas??[q(0),q(.5),q(1)],states=c.states??[0];
   const r=await compareFixture(c.name,c.source,lambdas,states);
   for(const run of r.runs){const expected=typeof c.expectedOutcome==='object'?c.expectedOutcome[String(run.state)]:c.expectedOutcome;
    if(expected==='success'||expected==='complete')assert.ok(run.baseline.complete,c.name+' expected completion atstate'+run.state);
    if(expected==='reject')assert.ok(!run.baseline.complete,c.name+' expected rejection');
    if(expected?.startsWith('revert:')){assert.ok(!run.baseline.complete,c.name+' expected rejection');assert.equal(run.baseline.rejected?.data?.slice(0,10),id(expected.slice(7)+'()').slice(0,10),c.name+' expected error');}}
   report.cases.push(r);save();console.log(JSON.stringify({case:c.name,passed:true,states:states.length}));}
 }
 const sum=(rows,stage)=>rows.filter(r=>stage===undefined||r.stage===stage).reduce((s,r)=>s+BigInt(r.gas),0n);
 report.nativeGas=report.native.map(c=>{const r=c.runs[0],a=sum(r.baseline.receipts,6),b=sum(r.candidate.receipts,6);return{work:c.work,unorderedPairs:120,baselinePairStageGas:String(a),candidatePairStageGas:String(b),pairGasSaved:String(a-b),pairGasSavingPercent:Number(a-b)/Number(a)*100,
   baselinePrePairGas:String(r.baseline.receipts.filter(x=>x.stage<6).reduce((s,r)=>s+BigInt(r.gas),0n)),candidatePrePairGas:String(r.candidate.receipts.filter(x=>x.stage<6).reduce((s,r)=>s+BigInt(r.gas),0n)),
   baselineCompleteEvaluationGas:String(sum(r.baseline.receipts)),candidateCompleteEvaluationGas:String(sum(r.candidate.receipts)),exactOutputWordsCompared:r.exactWordsCompared};});
 report.passed=true;report.status=process.argv.includes('--native-only')?'passed_native_only':'passed';report.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:report.status,native:report.nativeGas,caseCount:report.cases.length}));
}catch(e){report.status='failed';report.passed=false;report.failures.push({message:e.message,stack:e.stack});save();console.error(e);process.exitCode=1;}
finally{if(raw)await raw.disconnect();}
