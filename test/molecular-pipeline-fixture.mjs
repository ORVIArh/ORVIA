import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import solc from 'solc';
import ganache from 'ganache';
import {BrowserProvider,Contract,id,toBeHex,zeroPadValue,ZeroHash} from 'ethers';
import {artifacts,deploy,transact,quadFromNumber as q,qvec} from './helpers.mjs';

const word=x=>typeof x==='number'?toBeHex(x,32):zeroPadValue(x,32);
const gasLimit=28_000_000;
const copy=x=>JSON.parse(JSON.stringify(x));
const compilations=new Map();
// The historical shared build predates this connected path. Compile this fixture's
// complete dependency graph in memory, without changing shared artifacts/reports.
function compileFixture(banked=false){
 if(compilations.has(banked))return compilations.get(banked);
 const sources={};
 function add(file){
  if(sources[file])return;
  const content=fs.readFileSync(file,'utf8');sources[file]={content};
  for(const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1])));
 }
 for(const file of ['AlchemicalTopologyCatalog','AlchemicalHamiltonianEvaluator','MolecularSimulationPipeline',...(banked?['BankedWorkingState','BankedInputCatalog']:['ShardedWorkingState','PartitionedInputCatalog'])])add(`contracts/core/${file}.sol`);
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');
 const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}};
 const input={language:'Solidity',sources,settings};const output=JSON.parse(solc.compile(JSON.stringify(input)));
 const errors=output.errors?.filter(x=>x.severity==='error')??[];assert.equal(errors.length,0,errors.map(x=>x.formattedMessage).join('\n'));
 for(const[file,contracts]of Object.entries(output.contracts))for(const[name,c]of Object.entries(contracts))if(c.evm.bytecode.object)artifacts[name]={source:file,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
 const compilation={compiler:solc.version(),settings,sourceSha256:Object.fromEntries(Object.entries(sources).map(([file,{content}])=>[file,createHash('sha256').update(content).digest('hex')]))};
 compilations.set(banked,compilation);return compilation;
}

async function setup(t,options={}){
 const banked=options.banked===true;
 const compilation=compileFixture(banked);
 const coreDeployments=[];
 const deployCore=async(name,signer,args=[])=>{const c=await deploy(name,signer,args);const receipt=await c.deploymentTransaction().wait();coreDeployments.push({contract:name,address:await c.getAddress(),gas:String(receipt.gasUsed)});return c;};
 const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai',allowUnlimitedContractSize:true},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
 t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
 const owner=await provider.getSigner(0),contributor=await provider.getSigner(1),ownerAddress=await owner.getAddress();
 const math=await deployCore('FloatMath',owner),ma=await math.getAddress();
 const scalar=await deployCore('ScalarMath',owner,[ma]),elementary=await deployCore('ElementaryMath',owner,[ma]);
 const random=await deployCore('CounterRandom',owner,[ma,await scalar.getAddress(),await elementary.getAddress()]);
 const integrator=await deployCore('LangevinBAOABKernel',owner,[ma,await scalar.getAddress()]);
 const registry=await deployCore('ExperimentRegistry',owner,[ownerAddress]);
 const geometry=await deployCore('OrthorhombicGeometry',owner,[ma]);
 const bond=await deployCore('HarmonicBondKernel',owner,[ma]);
 const angle=await deployCore('HarmonicAngleKernel',owner,[ma,await elementary.getAddress()]);
 const torsion=await deployCore('PeriodicTorsionKernel',owner,[ma,await elementary.getAddress()]);
 const lj=await deployCore('LennardJonesKernel',owner,[ma]);
 const softcore=await deployCore('SoftcoreLennardJonesKernel',owner,[ma]);
 const realSpace=await deployCore('EwaldRealSpaceKernel',owner,[ma,await scalar.getAddress()]);
 const reciprocal=await deployCore('EwaldReciprocalKernel',owner,[ma,await scalar.getAddress(),await elementary.getAddress()]);
 const corrections=await deployCore('EwaldCorrections',owner,[ma,await scalar.getAddress()]);
 const inputs=await deployCore(banked?'BankedInputCatalog':'PartitionedInputCatalog',owner,[ownerAddress]);
 const topology=await deployCore('AlchemicalTopologyCatalog',owner,[ownerAddress,await inputs.getAddress(),ma,await geometry.getAddress()]);
 const all={registry,topology,math,integrator,random,geometry,bond,angle,torsion,lj,softcore,realSpace,reciprocal,corrections,inputs,scalar,elementary};
 const addresses=Object.fromEntries(await Promise.all(Object.entries(all).map(async([k,v])=>[k,await v.getAddress()])));
 const pipeline=await deployCore('MolecularSimulationPipeline',owner,[ownerAddress,Object.fromEntries(['registry','topology','math','integrator','random'].map(k=>[k,addresses[k]]))]);
 const state=await deployCore(banked?'BankedWorkingState':'ShardedWorkingState',owner,banked?[await pipeline.getAddress(),64]:[await pipeline.getAddress()]);
 const modules=Object.fromEntries(['registry','topology','math','geometry','bond','angle','torsion','lj','softcore','realSpace','reciprocal','corrections'].map(k=>[k,addresses[k]]));
 const hamiltonian=await deployCore('AlchemicalHamiltonianEvaluator',owner,[await pipeline.getAddress(),modules]);
 const output=await deployCore(banked?'BankedWorkingState':'ShardedWorkingState',owner,banked?[await hamiltonian.getAddress(),64]:[await hamiltonian.getAddress()]);
 const collector=await deployCore('ReducedPotentialCollector',owner,[await pipeline.getAddress(),ma]);
 const chronology=await deployCore('TimeSeriesDiagnostics',owner,[await pipeline.getAddress(),ma]);
 const estimator=await deployCore('MBARFreeEnergyEstimator',owner,[await collector.getAddress(),ma,await scalar.getAddress()]);
 const bankDeployments=[];
 if(banked){
  for(let i=0;i<96;i+=4){const r=await transact(inputs.createBanks(4,{gasLimit}));bankDeployments.push({pool:'input',gas:String(r.gasUsed)});}
  for(const [pool,router]of [['pipeline',state],['hamiltonian',output]])for(let i=0;i<64;i+=4){const r=await transact(router.deployBanks(4,{gasLimit}));bankDeployments.push({pool,gas:String(r.gasUsed)});}
 }
 await transact(pipeline.bind(await state.getAddress(),await hamiltonian.getAddress(),await output.getAddress(),await collector.getAddress(),await chronology.getAddress(),await estimator.getAddress(),{gasLimit}));
 const protocol=id('ORVIA-ALCHEMICAL-PIPELINE-VALIDATION');
 const registered=[...Object.values(addresses),...await Promise.all([pipeline,state,hamiltonian,output,collector,chronology,estimator].map(c=>c.getAddress()))];
 await transact(registry.registerProtocol(protocol,id('Unconstrained finite hybrid model fixture; not molecular acceptance'),registered));
 let serial=0;
 async function stream(role,values){
  if(!values.length)return ZeroHash;const sid=id(`hybrid-stream-${++serial}`),r=id(role);
  await transact(inputs.beginStream(sid,r,values.length));
  if(banked){for(let start=0;start<values.length;start+=128)await transact(inputs.appendWords(sid,values.slice(start,start+128).map(word)));}
  else for(let start=0;start<values.length;start+=4096){
   const chunk=values.slice(start,start+4096);const receipt=await transact(inputs.createPage(r,chunk.length));
   const event=receipt.logs.map(x=>{try{return inputs.interface.parseLog(x)}catch{return null}}).find(x=>x?.name==='PageCreated');
   const page=new Contract(event.args.page,artifacts.DataPage.abi,owner);
   for(let i=0;i<chunk.length;i+=128)await transact(page.append(chunk.slice(i,i+128).map(word)));
   await transact(page.seal(await page.rollingDigest()));await transact(inputs.appendPage(sid,await page.getAddress()));
  }
  await transact(inputs.sealStream(sid));return sid;
 }
 async function makeTopology(source,lambdas=[q(0),q(.5),q(1)]){
  const endpoint=async e=>({particles:await stream('PARTICLES',e.particles.flat()),nonbonded:await stream('NONBONDED',e.nonbonded.flat()),bonds:await stream('BONDS',e.bonds.flat()),angles:await stream('ANGLES',e.angles.flat()),torsions:await stream('TORSIONS',e.torsions.flat()),exceptions:await stream('EXCEPTIONS',e.exceptions.flat())});
  const d={modelPolicy:id('Declared finite fixture model; not drug inputs'),dummyPolicy:id('All fixture atoms physical; no disappearing atoms'),positions:await stream('POSITIONS',source.positions.flat()),a:await endpoint(source.a),b:await endpoint(source.b),atoms:source.positions.length,bonds:source.a.bonds.length,angles:source.a.angles.length,torsions:source.a.torsions.length,exceptions:source.a.exceptions.length,box:source.box,switchDistance:source.switchDistance,cutoff:source.cutoff,prefactor:source.prefactor,ewaldAlpha:source.alpha,ewaldExtent:source.extent,softcoreAlpha:source.softcoreAlpha};
  const tid=id(`hybrid-topology-${++serial}`);await transact(topology.create(tid,d,lambdas,{gasLimit}));
  for(let n=0;n<100;++n){if((await topology.info(tid)).stage===6n)return{tid,d,lambdas};await transact(topology.connect(contributor).advance(tid,8,{gasLimit}));}
  assert.fail('topology validation did not finish');
 }
 const policy=tid=>({protocol,topology:tid,leg:id('ORVIA.SOLVENT.v1'),seed:id('Pipeline repeat seed'),stream:id('Pipeline declared random stream'),replica:7,dt:q(1/32),friction:q(2),kT:q(1),equilibrationSteps:1,stride:1,samplesPerState:4,maxLag:1,minimumChronologySamples:4,mbarTolerance:q(1e-10),overlapThreshold:q(.01),minimumESS:q(1),normalizationTolerance:q(1e-8),maxMbarIterations:1000});
 async function campaign(tid,overrides={}){const cid=id(`hybrid-campaign-${++serial}`);await transact(pipeline.createCampaign(cid,{...policy(tid),...overrides},{gasLimit}));return cid;}
 async function start(cid,stateIndex){const run=await pipeline.nextRun();await transact(pipeline.connect(contributor).startWindow(cid,stateIndex,{gasLimit}));return run;}
 const gas=[];
 async function advance(run,work=8){const before=await pipeline.runInfo(run);const receipt=await transact(pipeline.connect(contributor).advance(run,work,{gasLimit}));gas.push({run:String(run),stage:Number(before.stage),step:String(before.step),work,gas:String(receipt.gasUsed)});return pipeline.runInfo(run);}
 async function initialize(run){for(let n=0;n<2000;++n){if((await pipeline.runInfo(run)).stage===4n)return;await advance(run,1);}assert.fail('initialization did not finish');}
 async function finish(run,schedule=[8]){for(let n=0;n<5000;++n){if((await pipeline.runInfo(run)).stage===11n)return;await advance(run,schedule[n%schedule.length]);}assert.fail('window did not finish');}
 async function stateAt(run,atoms){const r=[];for(let n=0;n<atoms;++n){const s=await pipeline.stateAt(run,n);r.push(s.map(x=>[...x]));}return r;}
 return{transport,provider,owner,contributor,math,topology,inputs,pipeline,state,output,hamiltonian,collector,chronology,estimator,protocol,makeTopology,campaign,start,advance,initialize,finish,stateAt,gas,compilation,coreDeployments,bankDeployments};
}

function harmonicFixture(){
 const a={particles:[[1,.125,0,0],[2,-.0625,0,0]].map(qvec),nonbonded:[[.5,0,0],[.5,0,0]].map(qvec),bonds:[[0,1,q(.25),q(1)]],angles:[],torsions:[],exceptions:[]};
 const b=copy(a);b.bonds[0][2]=q(.5);b.bonds[0][3]=q(.875);
 return{positions:[[0,0,0],[1.25,.25,.125]].map(qvec),a,b,box:qvec([8,8,8]),switchDistance:q(2),cutoff:q(3),prefactor:q(1),alpha:q(.75),extent:1,softcoreAlpha:q(.5)};
}


export {setup,harmonicFixture,gasLimit};
