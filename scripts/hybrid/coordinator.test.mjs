import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {domain,REPORT_TYPES,reportDigest,normalizeReport} from './attestation.mjs';
const require=createRequire(import.meta.url),solc=require('solc'),ganache=require('ganache');
const {BrowserProvider,Wallet,NonceManager,ContractFactory,Contract,id,keccak256,toBeHex,ZeroHash,ZeroAddress}=require('ethers');
const sha=x=>createHash('sha256').update(x).digest('hex'),out=new URL('../../../output/hybrid-contract-tests/',import.meta.url);
fs.mkdirSync(out,{recursive:true});
const report={schema:'orvia.hybrid-coordinator-tests.v1',passed:false,publicTransactionsSent:0,scope:'Local EVM authorization/lifecycle/256-address tests; no computation or scientific proof',checks:[]};
const save=()=>fs.writeFileSync(new URL('report.json',out),JSON.stringify(report,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n');save();
async function check(name,fn){await fn();report.checks.push(name);save();}

test('Hybrid coordinator binds operator reports and all255 persistent lanes',async()=>{
 const paths=['contracts/hybrid/ORVIAHybridCoordinator.sol','contracts/hybrid/ORVIAReportShard.sol'];
 const input={language:'Solidity',sources:Object.fromEntries(paths.map(p=>[p,{content:fs.readFileSync(p,'utf8')}])),settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','storageLayout']}}}};
 const compiled=JSON.parse(solc.compile(JSON.stringify(input))),errors=(compiled.errors??[]).filter(x=>x.severity==='error');assert.deepEqual(errors,[]);
 report.compilation={compiler:solc.version(),standardInputSha256:sha(JSON.stringify(input)),sourceHashes:Object.fromEntries(paths.map(p=>[p,sha(fs.readFileSync(p))]))};
 fs.writeFileSync(new URL('compiler-input.json',out),JSON.stringify(input));fs.writeFileSync(new URL('compiler-output.json',out),JSON.stringify(compiled));
 const artifact=compiled.contracts[paths[0]].ORVIAHybridCoordinator,shardArtifact=compiled.contracts[paths[1]].ORVIAReportShard;
 // Public deterministic test keys only; never production keys or funded addresses.
 const ownerKey=id('ORVIA public local test owner key DO NOT FUND'),opKey=id('ORVIA public local test operator key DO NOT FUND'),relayKey=id('ORVIA public local test relayer key DO NOT FUND');
 const vm=ganache.provider({logging:{quiet:true},chain:{chainId:4663,hardfork:'shanghai'},miner:{blockGasLimit:30000000},wallet:{accounts:[ownerKey,opKey,relayKey].map(secretKey=>({secretKey,balance:toBeHex(1000n*10n**18n)}))}});
 const provider=new BrowserProvider(vm);provider.pollingInterval=10;
 const ownerWallet=new Wallet(ownerKey,provider),operator=new Wallet(opKey,provider),relayWallet=new Wallet(relayKey,provider),owner=new NonceManager(ownerWallet),relay=new NonceManager(relayWallet);
 let contract;
 const send=async p=>{const tx=await p;const receipt=await tx.wait();assert.equal(receipt.status,1);return receipt;};
 const reject=async p=>{await assert.rejects(p);};
 try{
  const factory=new ContractFactory(artifact.abi,'0x'+artifact.evm.bytecode.object,owner);
  await check('Zero owner/operator constructors rejected',async()=>{await reject(factory.deploy(ZeroAddress,operator.address));await reject(factory.deploy(ownerWallet.address,ZeroAddress));owner.reset();});
  contract=await factory.deploy(ownerWallet.address,operator.address);const deployment=await contract.deploymentTransaction().wait();
  report.coordinator={address:contract.target,runtimeBytes:artifact.evm.deployedBytecode.object.length/2,deploymentGas:deployment.gasUsed,operator:operator.address};
  const cfg={protocolHash:id('protocol'),modelHash:id('model'),inputHash:id('input'),softwareHash:id('software'),environmentHash:id('environment'),requiredChecks:1,allowedChecks:3,diagnosticOnly:false};
  await check('Unready lifecycle and unauthorized provisioning rejected',async()=>{await reject(contract.registerExperiment.staticCall(id('exp'),cfg));await reject(contract.connect(relay).createShards.staticCall(1));await reject(contract.createShards.staticCall(0));await reject(contract.createShards.staticCall(9));});
  let deployGas=deployment.gasUsed;
  for(let k=0;k<255;k+=8)deployGas+=(await send(contract.createShards(Math.min(8,255-k),{gasLimit:15000000}))).gasUsed;
  await check('Exactly256 actual contracts, deterministic CREATE2 and immutable writer/code identities',async()=>{
   assert.equal(await contract.deploymentReady(),true);assert.equal(await contract.shardCount(),255n);const addresses=[contract.target.toLowerCase()];
   for(let k=0;k<255;k++){const a=await contract.shards(k);addresses.push(a.toLowerCase());assert.equal(a,await contract.predictShard(k));const code=await provider.getCode(a);assert.notEqual(code,'0x');assert.equal(keccak256(code),await contract.shardCodeHash(k));const shard=new Contract(a,shardArtifact.abi,provider);assert.equal(await shard.coordinator(),contract.target);assert.equal(await shard.index(),BigInt(k));assert.equal(await shard.coordinatorCodeHash(),keccak256(await provider.getCode(contract.target)));}
   assert.equal(new Set(addresses).size,256);assert.equal(await provider.getTransactionCount(contract.target),256);await reject(contract.createShards.staticCall(1));report.actualAddresses=256;report.deploymentGas=deployGas;
  });
  await check('Experiment ownership, nonzero fields and check-mask admission enforced',async()=>{
   await reject(contract.connect(relay).registerExperiment.staticCall(id('bad'),cfg));for(const key of ['protocolHash','modelHash','inputHash','softwareHash','environmentHash'])await reject(contract.registerExperiment.staticCall(id('bad'+key),{...cfg,[key]:ZeroHash}));await reject(contract.registerExperiment.staticCall(id('badflags'),{...cfg,requiredChecks:4}));await reject(contract.registerExperiment.staticCall(id('missingrequired'),{...cfg,requiredChecks:0}));await send(contract.registerExperiment(id('exp'),cfg));await reject(contract.registerExperiment.staticCall(id('exp'),cfg));
  });
  await send(contract.registerExperiment(id('diagnostic'),{...cfg,requiredChecks:0,allowedChecks:0,diagnosticOnly:true}));
  const initial=id('initialcheckpoint');const started=[];async function start(name,exp=id('exp')){const runId=id(name);await send(contract.startRun(exp,runId,id('runconfig/'+name),initial));const info=await contract.runInfo(runId);started.push(runId);return{runId,info};}
  const one=await start('primary');
  await check('Run IDs/configuration and initial checkpoint are immutable',async()=>{assert.equal(one.info.initialCheckpointHash,initial);assert.equal(one.info.runConfigHash,id('runconfig/primary'));assert.equal(one.info.status,1n);await reject(contract.startRun.staticCall(id('exp'),one.runId,id('other'),initial));await reject(contract.connect(relay).startRun.staticCall(id('exp'),id('unauthorized'),id('config'),initial));});
  const deadline=BigInt((await provider.getBlock('latest')).timestamp)+3600n;
  const base={runId:one.runId,configurationHash:one.info.configurationHash,sequence:1n,completedSteps:10n,previousCheckpointHash:initial,checkpointHash:id('checkpoint1'),resultHash:id('result1'),outcome:0,checks:1,validUntil:deadline};
  const sign=x=>operator.signTypedData(domain(4663,contract.target),REPORT_TYPES,x);
  const signature=await sign(base);
  await check('Independent EIP712 digest agrees with onchain digest and strict integer transport',async()=>{assert.equal(await contract.reportDigest(base),reportDigest(4663,contract.target,base));assert.equal(normalizeReport({...base,sequence:'18446744073709551615'}).sequence,(1n<<64n)-1n);assert.throws(()=>normalizeReport({...base,sequence:Number.MAX_SAFE_INTEGER+1}));assert.throws(()=>normalizeReport({...base,checks:'-1'}));});
  await check('Every signed field tamper is rejected',async()=>{for(const key of Object.keys(base)){const value=typeof base[key]==='string'?id('tamper/'+key):BigInt(base[key])+1n;await reject(contract.connect(relay).submitReport.staticCall({...base,[key]:value},signature));}});
  await check('Wrong chain, address, signer, expired and malformed/high-s signatures rejected',async()=>{
   for(const dom of [domain(1,contract.target),domain(4663,relayWallet.address)])await reject(contract.submitReport.staticCall(base,await operator.signTypedData(dom,REPORT_TYPES,base)));
   await reject(contract.submitReport.staticCall(base,await relayWallet.signTypedData(domain(4663,contract.target),REPORT_TYPES,base)));
   const expired={...base,validUntil:1};await reject(contract.submitReport.staticCall(expired,await sign(expired)));
   for(const malformed of ['0x',signature.slice(0,-2),signature.slice(0,-2)+'00','0x'+'00'.repeat(65)])await reject(contract.submitReport.staticCall(base,malformed));
   const order=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,s=BigInt('0x'+signature.slice(66,130)),v=parseInt(signature.slice(130),16);const high=signature.slice(0,66)+(order-s).toString(16).padStart(64,'0')+(v===27?'1c':'1b');await reject(contract.submitReport.staticCall(base,high));
  });
  await check('Permissionless relay advances state and stores exact historical report/event',async()=>{const receipt=await send(contract.connect(relay).submitReport(base,signature));const state=await contract.runInfo(one.runId),record=await contract.reportAt(one.runId,1);assert.equal(state.sequence,1n);assert.equal(state.completedSteps,10n);assert.equal(record.checkpointHash,base.checkpointHash);assert.equal(record.attestationDigest,reportDigest(4663,contract.target,base));assert(receipt.logs.some(x=>{try{return contract.interface.parseLog(x)?.name==='ReportAccepted';}catch{return false;}}));await reject(contract.submitReport.staticCall(base,signature));});
  await check('Lineage, monotonic work, masks and completion gates enforced',async()=>{
   for(const change of [{sequence:3n},{previousCheckpointHash:initial},{completedSteps:9n},{completedSteps:10n},{checks:4}]){const p={...base,sequence:2n,previousCheckpointHash:base.checkpointHash,...change};await reject(contract.submitReport.staticCall(p,await sign(p)));}
   const missing={...base,sequence:2n,previousCheckpointHash:base.checkpointHash,completedSteps:10n,outcome:1,checks:0};await reject(contract.submitReport.staticCall(missing,await sign(missing)));
   const final={...missing,checks:1,checkpointHash:id('finalcheckpoint'),resultHash:id('finalresult')};await send(contract.connect(relay).submitReport(final,await sign(final)));assert.equal((await contract.runInfo(one.runId)).status,2n);assert.equal((await contract.reportAt(one.runId,1)).resultHash,base.resultHash);await reject(contract.submitReport.staticCall({...final,sequence:3},await sign({...final,sequence:3})));await reject(contract.cancelRun.staticCall(one.runId,id('cannotcancelterminal')));
  });
  await check('Diagnostic completion and failed outcome cannot masquerade as non-diagnostic completion',async()=>{
   const diag=await start('diag',id('diagnostic'));const p={...base,runId:diag.runId,configurationHash:diag.info.configurationHash,outcome:1,checks:0,completedSteps:0};await send(contract.submitReport(p,await sign(p)));const dr=await contract.runInfo(diag.runId);assert.equal(dr.status,2n);assert.equal(dr.diagnosticOnly,true);
   const fail=await start('failed');const f={...p,runId:fail.runId,configurationHash:fail.info.configurationHash,outcome:2};await send(contract.submitReport(f,await sign(f)));assert.equal((await contract.runInfo(fail.runId)).status,3n);
  });
  await check('Only owner cancellation; cancelled run is terminal',async()=>{const x=await start('cancelled');await reject(contract.connect(relay).cancelRun.staticCall(x.runId,id('reason')));await send(contract.cancelRun(x.runId,id('reason')));assert.equal((await contract.runInfo(x.runId)).status,4n);const p={...base,runId:x.runId,configurationHash:x.info.configurationHash};await reject(contract.submitReport.staticCall(p,await sign(p)));});
  await check('Mixed-validity batch rolls back prior reports and all events',async()=>{const x=await start('batch-a'),y=await start('batch-b');const p={...base,runId:x.runId,configurationHash:x.info.configurationHash},q={...base,runId:y.runId,configurationHash:y.info.configurationHash};const tx=await contract.connect(relay).submitReports([p,q],[await sign(p),'0x'],{gasLimit:2000000});let receipt;try{receipt=await tx.wait();}catch(e){receipt=e.receipt;}assert.equal(receipt.status,0);assert.equal(receipt.logs.length,0);assert.equal((await contract.runInfo(x.runId)).sequence,0n);assert.equal((await contract.runInfo(y.runId)).sequence,0n);await send(contract.connect(relay).submitReports([p,q],[await sign(p),await sign(q)]));await reject(contract.submitReports.staticCall([],[]));await reject(contract.submitReports.staticCall([p],[]));await reject(contract.submitReports.staticCall(Array(9).fill(p),Array(9).fill(await sign(p))));});
  await check('Shard direct writes and runtime replacement rejected including terminal reads',async()=>{const lane=Number(await contract.laneFor(one.runId)),a=await contract.shards(lane),shard=new Contract(a,shardArtifact.abi,relay);await reject(shard.cancelRun.staticCall(one.runId,id('attack')));const snapshot=await vm.request({method:'evm_snapshot',params:[]});await vm.request({method:'evm_setAccountCode',params:[a,'0x60006000f3']});await reject(contract.runInfo(one.runId));await vm.request({method:'evm_revert',params:[snapshot]});owner.reset();relay.reset();});
  await check('Every one of255 lanes stores a distinct run without child creation',async()=>{const names=new Map();for(let i=0;names.size<255;i++){const runId=id('all-lanes/'+i);const lane=Number(await contract.laneFor(runId));if(!names.has(lane))names.set(lane,runId);}const before=await provider.getTransactionCount(contract.target);for(const [lane,runId]of names){await send(contract.startRun(id('exp'),runId,id('laneconfig/'+lane),initial));assert.equal(await contract.shardFor(runId),await contract.shards(lane));assert.equal((await contract.runInfo(runId)).status,1n);}assert.equal(await provider.getTransactionCount(contract.target),before);report.exercisedLanes=255;});
  report.passed=true;report.status='passed_local_256_address_lifecycle';
 }catch(error){report.error=error.stack;throw error;}finally{await vm.disconnect();save();}
});
