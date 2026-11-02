import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import solc from 'solc';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,id,zeroPadValue} from 'ethers';
import {quadFromNumber as q,qvec} from './helpers.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const gasLimit=28_000_000;
const plain=x=>Array.isArray(x)?Array.from(x,plain):x;
function compile(){
 const sources={};function add(f){if(sources[f])return;const content=fs.readFileSync(f,'utf8');sources[f]={content};for(const m of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(f),m[1])));}
 for(const f of ['contracts/core/BankedWorkingState.sol','contracts/core/OrderedNeighborPairs.sol','test/contracts/WorkingStateWriterHarness.sol','test/contracts/OrderedPairOwnerHarness.sol','test/contracts/PeriodicCellOracleHarness.sol'])add(f);
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');
 const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}};
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}))),errors=out.errors?.filter(x=>x.severity==='error')??[];
 assert.equal(errors.length,0,errors.map(x=>x.formattedMessage).join('\n'));
 const artifacts={};for(const cs of Object.values(out.contracts))for(const[name,c]of Object.entries(cs))artifacts[name]={abi:c.abi,bytecode:'0x'+c.evm.bytecode.object};
 return{artifacts,evidence:{compiler:solc.version(),settings,sourceSha256:Object.fromEntries(Object.entries(sources).map(([p,s])=>[p,sha(s.content)]))}};
}

test('ordered cell traversal preserves canonical pairs, bounded progress and consumer rollback',async t=>{
 const report={schemaVersion:1,status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'Local candidate-pair enumeration and synthetic consumer rollback; not integrated Hamiltonian forces, full molecular execution or production speedup.',
  testSourceSha256:sha(fs.readFileSync(new URL(import.meta.url))),gas:[]};
 const save=()=>{fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/ordered_neighbor_pairs_validation.json',JSON.stringify(report,null,2)+'\n');};save();
 try{
  const{artifacts,evidence}=compile();report.compilation=evidence;
  const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
  t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
  const owner=await provider.getSigner(0),outsider=await provider.getSigner(1),ownerAddress=await owner.getAddress();
  async function deploy(name,args=[]){const a=artifacts[name],c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args);await c.waitForDeployment();return c;}
  const send=async p=>(await p).wait();
  const math=await deploy('FloatMath'),geometry=await deploy('OrthorhombicGeometry',[math.target]);
  const registry=await deploy('ExperimentRegistry',[ownerAddress]),writer=await deploy('WorkingStateWriterHarness');
  const state=await deploy('BankedWorkingState',[writer.target,2]);await send(state.deployBanks(2,{gasLimit}));
  const cells=await deploy('PeriodicCellIndex',[ownerAddress,registry.target,math.target,geometry.target]);
  const consumer=await deploy('OrderedPairOwnerHarness'),pairs=await deploy('OrderedNeighborPairs',[consumer.target,cells.target]);
  const oracle=await deploy('PeriodicCellOracleHarness');
  const protocol=id('ordered-cell-pairs-fixture');await send(registry.registerProtocol(protocol,id('candidate traversal fixture, no production force acceptance'),[math.target,geometry.target,writer.target,state.target,cells.target,pairs.target,consumer.target]));
  const forward=(method,args)=>writer.forward(state.target,state.interface.encodeFunctionData(method,args),{gasLimit});
  const positions=[[-3.99,0,0],[3.99,0,0],[0,0,0],[0,0,0],[.5,0,0],[2.75,2.75,2.75],[-12,0,0],[4,0,0],[1.25,0,0]].map(qvec);
  const namespace=id('ordered-pair-source'),snapshot=id('ordered-pair-snapshot');
  await send(forward('createNamespace',[namespace,positions.length*3]));await send(forward('writeWords',[namespace,0,positions.flat().map(x=>zeroPadValue(x,32))]));
  await send(forward('snapshotNamespace',[namespace,snapshot]));
  const input={protocol,sourcePage:state.target,sourceNamespace:snapshot,atoms:positions.length,positionOffset:0,positionStride:3,box:qvec([8,8,8]),cutoff:q(1)};
  const cellId=await cells.nextIndex();await send(cells.registerIndex(input,{gasLimit}));
  await assert.rejects(consumer.register.staticCall(pairs.target,cellId));
  await send(cells.connect(outsider).advanceBuild(cellId,positions.length,{gasLimit}));
  const create=async()=>{const n=await pairs.nextTraversal();await send(consumer.register(pairs.target,cellId,{gasLimit}));return n;};
  async function pull(traversal,work){const receipt=await send(consumer.pull(pairs.target,traversal,work,{gasLimit}));report.gas.push({scenario:'bounded canonical merge',work,gasUsed:String(receipt.gasUsed)});return receipt.logs.map(l=>{try{return consumer.interface.parseLog(l)}catch{return null}}).find(l=>l?.name==='Pulled').args;}
  async function finish(traversal,schedule){const output=[];let totalWork=0n;for(let n=0;n<500;++n){const result=await pull(traversal,schedule[n%schedule.length]);assert(result.processed>0n||result.complete);assert(result.processed<=BigInt(schedule[n%schedule.length]));totalWork+=result.processed;if(result.found){assert(result.a<result.b);output.push([Number(result.a),Number(result.b)]);}if(result.complete)return{output,totalWork};}assert.fail('traversal did not finish');}
  let successful=0;
  await t.test('merge emits every candidate once in global i,j order and contains all EVM cutoff pairs',async()=>{
   const expected=[],required=[];
   for(let a=0;a<positions.length;++a){
    const neighbors=await cells.neighboringCells(cellId,a),members=[];
    for(let c=0;c<Number(neighbors.count);++c){const page=await cells.cellAtoms(cellId,neighbors.cellIds[c],0,128);assert(page.complete);members.push(...page.atoms.map(Number));}
    for(const b of members.sort((x,y)=>x-y))if(b>a)expected.push([a,b]);
    for(const b of await oracle.bruteNeighbors(math.target,geometry.target,positions,a,input.box,input.cutoff,{gasLimit}))if(b>BigInt(a))required.push([a,Number(b)]);
   }
   assert.equal(new Set(expected.map(String)).size,expected.length);
   assert(expected.length>required.length,'Fixture must preserve outside-cutoff candidates for the owner to filter');
   const a=await create(),b=await create(),first=await finish(a,[32]),second=await finish(b,[1,3,8,2]);
   assert.deepEqual(first.output,expected);assert.deepEqual(second.output,expected);assert.equal(first.totalWork,second.totalWork);
   assert.deepEqual(first.output,[...first.output].sort((x,y)=>x[0]-y[0]||x[1]-y[1]));
   for(const pair of required)assert(first.output.some(p=>p[0]===pair[0]&&p[1]===pair[1]));
   report.coverage={atoms:positions.length,candidatePairs:expected.length,exactEvmInsidePairs:required.length,outsideCutoffCandidatesPreserved:expected.length-required.length,
    duplicatePairs:0,missedInsidePairs:0,canonicalOrder:true,partitionInvariant:true,workUnits:String(first.totalWork)};
   ++successful;
  });
  await t.test('only the code-pinned consumer may pull; its failure rolls back cursor and pair counts',async()=>{
   const traversal=await create();await assert.rejects(pairs.connect(outsider).advance.staticCall(traversal,8));
   await assert.rejects(pairs.registerTraversal.staticCall(cellId));
   for(const work of[0,33])await assert.rejects(consumer.pull.staticCall(pairs.target,traversal,work));
   const before=plain(await pairs.traversalInfo(traversal));
   await assert.rejects(send(consumer.pullThenFail(pairs.target,traversal,32,{gasLimit})));
   assert.deepEqual(plain(await pairs.traversalInfo(traversal)),before);
   const result=await pull(traversal,32);assert.equal(result.found,true);assert.equal(result.a,0n);assert(result.b>0n);
   report.rollback={consumerFailureRollsBack:true,externalConsumptionRejected:true,boundsEnforced:true};++successful;
  });
  await t.test('terminal calls remain idempotent and reject changed dependencies/owner code',async()=>{
   const traversal=await create();await finish(traversal,[32]);
   const terminal=await pull(traversal,1);assert.equal(terminal.processed,0n);assert.equal(terminal.complete,true);assert.equal(terminal.found,false);
   const original=await provider.getCode(cells.target);await provider.send('evm_setAccountCode',[cells.target,'0x00']);
   await assert.rejects(consumer.pull.staticCall(pairs.target,traversal,1));await provider.send('evm_setAccountCode',[cells.target,original]);
   const ownerCode=await provider.getCode(consumer.target);await provider.send('evm_setAccountCode',[consumer.target,'0x00']);
   await assert.rejects(provider.call({from:consumer.target,to:pairs.target,data:pairs.interface.encodeFunctionData('advance',[traversal,1])}));
   await provider.send('evm_setAccountCode',[consumer.target,ownerCode]);
   const restored=await pull(traversal,1);assert.equal(restored.complete,true);assert.equal(restored.processed,0n);
   report.terminal={idempotent:true,cellRuntimeChecked:true,ownerRuntimeChecked:true};++successful;
  });
  assert.equal(successful,3);for(const[p,hash]of Object.entries(evidence.sourceSha256))assert.equal(sha(fs.readFileSync(p)),hash);
  report.passed=true;report.status='passed';
 }finally{save();}
});
