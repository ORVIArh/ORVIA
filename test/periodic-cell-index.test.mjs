import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import solc from 'solc';
import ganache from 'ganache';
import {BrowserProvider,ContractFactory,ZeroHash,id,toBeHex,zeroPadValue} from 'ethers';
import {quadFromNumber as q,qvec} from './helpers.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const gasLimit=28_000_000;
const word=x=>zeroPadValue(x,32);
const plain=x=>Array.isArray(x)?Array.from(x,plain):x;
function compile(){
 const sources={};function add(file){if(sources[file])return;const content=fs.readFileSync(file,'utf8');sources[file]={content};for(const m of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g))add(path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1])));}
 for(const f of ['contracts/core/PeriodicCellIndex.sol','contracts/core/BankedWorkingState.sol','test/contracts/WorkingStateWriterHarness.sol','test/contracts/PeriodicCellOracleHarness.sol'])add(f);
 assert.equal(solc.version(),'0.8.26+commit.8a97fa7a.Emscripten.clang');
 const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}};
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings})));
 const errors=out.errors?.filter(x=>x.severity==='error')??[];assert.equal(errors.length,0,errors.map(x=>x.formattedMessage).join('\n'));
 const artifacts={};for(const contracts of Object.values(out.contracts))for(const[name,c]of Object.entries(contracts))artifacts[name]={abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,runtime:'0x'+c.evm.deployedBytecode.object};
 return{artifacts,evidence:{compiler:solc.version(),settings,sourceSha256:Object.fromEntries(Object.entries(sources).map(([p,s])=>[p,sha(s.content)]))}};
}

test('periodic cells derive bounded stable candidates from authenticated on-chain positions',async t=>{
 const report={schemaVersion:1,status:'in_progress',passed:false,mainnetTransactionsSent:0,
  scope:'Local candidate membership and exact-EVM cutoff coverage. Not integrated in a force evaluator; no full-model speed, ensemble, or mainnet fee claim.',
  testSourceSha256:sha(fs.readFileSync(new URL(import.meta.url))),gas:[]};
 const save=()=>{fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/periodic_cell_index_validation.json',JSON.stringify(report,null,2)+'\n');};save();
 try{
  report.boundAudit=JSON.parse(execFileSync('python3',['reference/periodic_cell_bounds.py'],{encoding:'utf8'}));
  assert.equal(report.boundAudit.passed,true);report.boundAuditSourceSha256=sha(fs.readFileSync('reference/periodic_cell_bounds.py'));
  const{artifacts,evidence}=compile();report.compilation=evidence;
  const transport=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'},miner:{blockGasLimit:30_000_000},wallet:{totalAccounts:3}});
  t.after(()=>transport.disconnect());const provider=new BrowserProvider(transport);provider.pollingInterval=10;
  const owner=await provider.getSigner(0),outsider=await provider.getSigner(1),ownerAddress=await owner.getAddress();
  async function deploy(name,args=[]){const a=artifacts[name],c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args);await c.waitForDeployment();return c;}
  const send=async p=>(await p).wait();
  const math=await deploy('FloatMath'),geometry=await deploy('OrthorhombicGeometry',[await math.getAddress()]);
  const registry=await deploy('ExperimentRegistry',[ownerAddress]),writer=await deploy('WorkingStateWriterHarness');
  const state=await deploy('BankedWorkingState',[await writer.getAddress(),2]);await send(state.deployBanks(2,{gasLimit}));
  const index=await deploy('PeriodicCellIndex',[ownerAddress,await registry.getAddress(),await math.getAddress(),await geometry.getAddress()]);
  const oracle=await deploy('PeriodicCellOracleHarness');
  const protocol=id('periodic-cell-index-fixture');
  await send(registry.registerProtocol(protocol,id('candidate-only geometry fixture; no scientific acceptance'),await Promise.all([math,geometry,state,writer,index].map(c=>c.getAddress()))));
  const forward=(method,args)=>writer.forward(state.target,state.interface.encodeFunctionData(method,args),{gasLimit});
  let serial=0;
  async function source(positions,{atoms=positions?.length,offset=0,stride=3,updates=[]}={}){
   const namespace=id('cell-source-'+ ++serial),snapshot=id('cell-snapshot-'+serial),capacity=offset+(atoms-1)*stride+3;
   await send(forward('createNamespace',[namespace,capacity]));
   if(positions&&stride===3){const values=positions.flat().map(word);for(let i=0;i<values.length;i+=128)await send(forward('writeWords',[namespace,offset+i,values.slice(i,i+128)]));}
   else if(positions)for(let a=0;a<positions.length;++a)await send(forward('writeWords',[namespace,offset+a*stride,positions[a].map(word)]));
   for(const[a,position]of updates)await send(forward('writeWords',[namespace,offset+a*stride,position.map(word)]));
   await send(forward('snapshotNamespace',[namespace,snapshot]));
   return{protocol,sourcePage:state.target,sourceNamespace:snapshot,atoms,positionOffset:offset,positionStride:stride,box:qvec([8,8,8]),cutoff:q(1)};
  }
  async function register(input){const next=await index.nextIndex();await send(index.registerIndex(input,{gasLimit}));return next;}
  async function build(job,schedule=[32]){for(let calls=0;calls<10000;++calls){if((await index.indexInfo(job)).stage===2n)return;const work=schedule[calls%schedule.length];const receipt=await send(index.connect(outsider).advanceBuild(job,work,{gasLimit}));report.gas.push({scenario:'build',work,gasUsed:String(receipt.gasUsed)});}assert.fail('build did not complete');}
  async function members(job,cell,pageSize=3){const result=[];let cursor=0n;for(let n=0;n<10000;++n){const page=await index.cellAtoms(job,cell,cursor,pageSize);for(const atom of page.atoms)result.push(Number(atom));if(page.complete){assert.equal(page.next,0n);break;}assert(page.next>cursor);cursor=page.next;}assert.deepEqual(result,[...new Set(result)].sort((a,b)=>a-b));return result;}
  async function candidates(job,atom,pageSize=3){const neighbors=await index.neighboringCells(job,atom),cells=neighbors.cellIds.slice(0,Number(neighbors.count));assert.equal(new Set(cells.map(String)).size,cells.length);const result=[];for(let c=0;c<cells.length;++c)if(neighbors.heads[c]!==0n)result.push(...await members(job,cells[c],pageSize));assert.equal(new Set(result).size,result.length);return result.sort((a,b)=>a-b);}
  let successful=0;
  await t.test('every exact-EVM inside-cutoff pair is present at periodic, cell-face and coincident boundaries',async()=>{
   const width=await math.div(q(8),q(7)),face=await math.sub(width,q(4));
   const faceBelow=toBeHex(BigInt(face)+1n,16),faceAbove=toBeHex(BigInt(face)-1n,16); // negative-number encoding reverses order.
   const positions=[[-3.99,0,0],[3.99,0,0],[-4,0,0],[4,0,0],[-12,0,0],[12,0,0],[0,0,0],[0,0,0],
    [1,1,1],[2,1,1],[32.25,-24.25,16.125],[-31.75,23.75,-15.875],[2**33,0,0],[-(2**33),0,0]].map(qvec);
   positions.push([face,q(0),q(0)],[faceBelow,q(0),q(0)],[faceAbove,q(0),q(0)]);
   const input=await source(positions),job=await register(input);await assert.rejects(index.atomCell(job,0));await build(job,[1,7,3,11]);
   assert.deepEqual([...((await index.indexInfo(job)).dimensions)],[7n,7n,7n]);
   let checked=0,included=0;
   for(let a=0;a<positions.length;++a){
    const actual=await candidates(job,a),expected=[...await oracle.bruteNeighbors(math.target,geometry.target,positions,a,input.box,input.cutoff,{gasLimit})].map(Number);
    assert(actual.includes(a));for(const b of expected){assert(actual.includes(b),`missed exact EVM pair ${a},${b}`);++included;}checked+=positions.length;
   }
   const all=[];for(let atom=0;atom<positions.length;++atom){const cell=await index.atomCell(job,atom);if(!all.includes(String(cell)))all.push(String(cell));}
   const listed=[];for(const cell of all)listed.push(...await members(job,BigInt(cell),2));assert.deepEqual(listed.sort((a,b)=>a-b),Array.from({length:positions.length},(_,i)=>i));
   const before=await state.readWord(input.sourceNamespace,0);await send(forward('writeWord',[id('cell-source-'+serial),0,word(q(3))]));assert.equal(await state.readWord(input.sourceNamespace,0),before);
   report.bruteForce={atoms:positions.length,orderedDistancesChecked:checked,insideIncludingSelfAndCoincident:included,missedInsidePairs:0,sourceMutationDoesNotChangeSnapshot:true};++successful;
  });
  await t.test('one/two-cell grids deduplicate neighbors and the grid is bounded explicitly',async()=>{
   const positions=[[0,0,0],[3.99,-3.99,0],[0,0,0]].map(qvec);
   const base=await source(positions);
   for(const[cutoff,dimension,neighborCount]of [[q(4-2**-40),1,1],[q(3),2,8],[q(2.5),3,27],[q(2**-64),64,27]]){
    const input={...base,cutoff},job=await register(input);await build(job);
    const info=await index.indexInfo(job);assert.deepEqual([...info.dimensions],Array(3).fill(BigInt(dimension)));assert.equal(info.totalCells,BigInt(dimension**3));
    assert.equal((await index.neighboringCells(job,0)).count,BigInt(neighborCount));
    for(let a=0;a<positions.length;++a){const actual=await candidates(job,a);for(const b of await oracle.bruteNeighbors(math.target,geometry.target,positions,a,input.box,input.cutoff,{gasLimit}))assert(actual.includes(Number(b)));}
   }
   const job=await register({...base,cutoff:q(1)});await build(job);
   const aCell=await index.atomCell(job,0),bCell=await index.atomCell(job,1);assert.notEqual(aCell,bCell);
   await assert.rejects(index.cellAtoms(job,aCell,2,1));await assert.rejects(index.cellAtoms(job,aCell,4,1));
   await assert.rejects(index.cellAtoms(job,aCell,0,0));await assert.rejects(index.cellAtoms(job,aCell,0,129));
   await assert.rejects(index.cellAtoms(job,343,0,1));
   report.grid={maximumAxis:64,maximumTotalCells:262144,deduplicatedOneAndTwoCellAxes:true,invalidCursorRejected:true};++successful;
  });
  await t.test('partitioning is exact; invalid source/domain and changed runtime fail closed',async()=>{
   const positions=[[0,0,0],[.25,0,0],[2,2,2],[-7.75,0,0]].map(qvec),input=await source(positions),job=await register(input);
   await assert.rejects(index.connect(outsider).registerIndex.staticCall(input));
   for(const work of[0,33])await assert.rejects(index.advanceBuild.staticCall(job,work));
   const fork=await provider.send('evm_snapshot',[]);await build(job,[32]);const info=plain(await index.indexInfo(job)),expected=[];
   for(let a=0;a<positions.length;++a)expected.push({cell:await index.atomCell(job,a),candidates:await candidates(job,a)});
   assert.equal(await provider.send('evm_revert',[fork]),true);await build(job,[1]);assert.deepEqual(plain(await index.indexInfo(job)),info);
   for(let a=0;a<positions.length;++a){assert.equal(await index.atomCell(job,a),expected[a].cell);assert.deepEqual(await candidates(job,a),expected[a].candidates);}
   assert.deepEqual([...await index.advanceBuild.staticCall(job,32)],[0n,true]);
   for(const change of[{positionStride:2},{positionOffset:999999},{sourceNamespace:ZeroHash},{cutoff:q(4)},
    {cutoff:q(2**-65)},{box:qvec([2**-33,8,8]),cutoff:q(2**-36)},{box:qvec([2**33,8,8])}])await assert.rejects(index.registerIndex.staticCall({...input,...change}));
   const invalid=await source([[0,0,0],[8*(2**30+1),0,0]].map(qvec)),invalidJob=await register(invalid);
   await assert.rejects(send(index.advanceBuild(invalidJob,2,{gasLimit})));assert.equal((await index.indexInfo(invalidJob)).builtAtoms,0n);
   const malformed=await source([[0,0,0],[0,0,0]].map(qvec));
   const mutable=id('cell-source-'+serial);await send(forward('writeWord',[mutable,3,toBeHex(1n<<200n,32)]));
   const malformedSnap=id('malformed-cell-snapshot');await send(forward('snapshotNamespace',[mutable,malformedSnap]));
   const malformedJob=await register({...malformed,sourceNamespace:malformedSnap});await assert.rejects(send(index.advanceBuild(malformedJob,2,{gasLimit})));assert.equal((await index.indexInfo(malformedJob)).builtAtoms,0n);
   const original=await provider.getCode(math.target);await provider.send('evm_setAccountCode',[math.target,'0x00']);
   await assert.rejects(index.atomCell(job,0));await assert.rejects(index.advanceBuild.staticCall(job,1));
   await provider.send('evm_setAccountCode',[math.target,original]);
   assert.deepEqual([...await index.advanceBuild.staticCall(job,1)],[0n,true]);
   report.identity={registeredFrozenSourceRequired:true,partialBuildRollback:true,unsupportedDomainRejected:true,nonCanonicalWordRejected:true,codeChangeRejected:true,exactPartitionMembership:true};++successful;
  });
  await t.test('all1500 real indexed atoms retain stable cursors at large global source-word offsets',async()=>{
   const input=await source(null,{atoms:1500,offset:1_000_000,stride:9,updates:[[1499,qvec([.25,0,0])]]}),job=await register(input);await build(job,[32]);
   const info=await index.indexInfo(job);assert.equal(info.builtAtoms,1500n);assert.equal(info.stage,2n);
   const list=await candidates(job,1499,128);assert.deepEqual(list,Array.from({length:1500},(_,i)=>i));
   assert.equal((await index.cellAtoms(job,await index.atomCell(job,1499),1490,16)).atoms[0],1489n);
   report.largeIndices={actualIndexedAtoms:1500,sourceWordOffset:1000000,stride:9,lastAtomSourceWord:1013491,
    ascendingCoverageWithoutRepeatsOrSkips:true,completeMolecularForcePass:false};++successful;
  });
  assert.equal(successful,4);for(const[file,hash]of Object.entries(report.compilation.sourceSha256))assert.equal(sha(fs.readFileSync(file)),hash);
  assert.equal(sha(fs.readFileSync(new URL(import.meta.url))),report.testSourceSha256);report.passed=true;report.status='passed';
 }finally{save();}
});
