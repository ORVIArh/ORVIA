import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contract, id } from 'ethers';
import { artifacts, environment, deploy, transact, quadFromNumber as q, qvec } from './helpers.mjs';
const gasLimit=28_000_000;
test('Neighbor lists are resumable, snapshot-based and conservative under motion',async t=>{
 const env=await environment();t.after(()=>env.transport.disconnect());const{owner,contributor}=env;
 const math=await deploy('FloatMath',owner),geometry=await deploy('OrthorhombicGeometry',owner,[await math.getAddress()]);
 const writer=await deploy('NeighborListHarness',owner);await transact(writer.configure(await math.getAddress(),await geometry.getAddress()));
 const list=new Contract(await writer.list(),artifacts.NeighborList.abi,owner),page=new Contract(await writer.page(),artifacts.WorkingStatePage.abi,owner);
 let serial=0;
 async function setup(positions,exceptions=[]){const ns=id(`neighbor-list-${++serial}`),n=positions.length;await transact(writer.register(ns,n,qvec([8,8,8]),q(2),q(.5)));for(let i=0;i<n;i++)await transact(writer.position(ns,n,0,i,qvec(positions[i])));for(const e of exceptions)await transact(writer.exception(ns,...e));return{ns,n,positions};}
 async function finish(ns,schedule=[8]){for(let i=0;i<100;i++){if((await list.listInfo(ns)).stage===5n)return;await transact(writer.advance(ns,schedule[i%schedule.length],{gasLimit}));}assert.fail('preparation timeout');}
 async function indices(ns){const info=await list.listInfo(ns),out=[];for(let i=0;i<Number(info.candidateCount);i++)out.push(Number(await list.pairIndexAt(ns,i)));return out;}
 const f=await setup([[7.9375,0,0],[.4375,0,0],[3,0,0],[4,.5,0]],[[0,1,1],[0,2,2]]);
 await t.test('registration binds writer and rejects invalid skin, box or exception configuration',async()=>{
  await assert.rejects(list.connect(contributor).registerList(id('rogue'),2,qvec([8,8,8]),q(2),q(.5)));
  await assert.rejects(writer.register(f.ns,4,qvec([8,8,8]),q(2),q(.5)));
  for(const skin of[0,-1,2,2**-40,2**-120])await assert.rejects(writer.register(id(`bad-${skin}`),2,qvec([8,8,8]),q(2),q(skin)));
  await assert.rejects(writer.register(id('unsafe-box-scale'),2,qvec([8,2**40,8]),q(2),q(.5)));
  await transact(writer.register(id('minimum-box-scaled-skin'),2,qvec([8,8,8]),q(2),q(2**-29)));
  await assert.rejects(writer.exception(f.ns,0,1,2));await assert.rejects(writer.exception(f.ns,2,1,1));await assert.rejects(list.connect(contributor).beginEvaluation(f.ns,0));
  assert.equal((await list.parameters(f.ns)).thresholdSquared,q((.5*127/256)**2));
 });
 await t.test('incomplete lists cannot be read; complete candidates are ordered and include distant exceptions',async()=>{
  await transact(writer.begin(f.ns,0));await assert.rejects(list.pairIndexAt(f.ns,0));await transact(writer.advance(f.ns,1,{gasLimit}));assert.equal((await list.listInfo(f.ns)).cursor,1n);await assert.rejects(list.referenceAt(f.ns,0));await finish(f.ns,[1,3,2]);
  const expected=[];let index=0;for(let a=0;a<4;a++)for(let b=a+1;b<4;b++,index++){if(a===0&&b===1)continue;let r2=0;for(let d=0;d<3;d++){let x=f.positions[b][d]-f.positions[a][d];x-=Math.round(x/8)*8;r2+=x*x;}if((a===0&&b===2)||r2<=2.5**2)expected.push(index);}
  assert.deepEqual(await indices(f.ns),expected);assert.ok(expected.includes(1));assert.equal((await list.listInfo(f.ns)).generation,1n);assert.deepEqual([...await list.referenceAt(f.ns,0)],qvec(f.positions[0]));await assert.rejects(writer.exception(f.ns,1,2,1));await assert.rejects(writer.advance(f.ns,1));
 });
 await t.test('small unwrapped face crossing reuses; half-skin movement rebuilds',async()=>{
  const original=await indices(f.ns);await transact(writer.position(f.ns,4,1,0,qvec([8.0625,0,0])));for(let i=1;i<4;i++)await transact(writer.position(f.ns,4,1,i,qvec(f.positions[i])));await transact(writer.begin(f.ns,1));await finish(f.ns,[2]);assert.equal((await list.listInfo(f.ns)).generation,1n);assert.equal((await list.listInfo(f.ns)).reuseCount,1n);assert.deepEqual(await indices(f.ns),original);assert.deepEqual([...await list.referenceAt(f.ns,0)],qvec(f.positions[0]));
  await transact(writer.position(f.ns,4,1,0,qvec([8.1875,0,0])));await transact(writer.begin(f.ns,1));await finish(f.ns);assert.equal((await list.listInfo(f.ns)).generation,2n);assert.deepEqual([...await list.referenceAt(f.ns,0)],qvec([8.1875,0,0]));
 });
 await t.test('a pair entering cutoff triggers rebuild and remains in candidate coverage',async()=>{
  const a=await setup([[0,0,0],[2.75,0,0],[0,1,0]]);await transact(writer.begin(a.ns,0));await finish(a.ns);assert.ok(!(await indices(a.ns)).includes(0));await transact(writer.position(a.ns,3,0,1,qvec([1.875,0,0])));await transact(writer.begin(a.ns,0));await finish(a.ns,[1]);assert.equal((await list.listInfo(a.ns)).generation,2n);assert.ok((await indices(a.ns)).includes(0));
 });
 await t.test('namespaces and transaction partitions preserve candidate ordering including radius equality',async()=>{
  const a=await setup([[0,0,0],[2.5,0,0],[3.5,0,0]]),b=await setup([[0,0,0],[2.5,0,0],[3.5,0,0]]);await transact(writer.begin(a.ns,0));await finish(a.ns,[1]);await transact(writer.begin(b.ns,0));await finish(b.ns,[8]);assert.deepEqual(await indices(a.ns),await indices(b.ns));assert.ok((await indices(a.ns)).includes(0));await assert.rejects(list.pairIndexAt(a.ns,99));
 });
 await t.test('invalid coordinates roll back same-transaction page writes and preparation cursor',async()=>{
  await transact(writer.begin(f.ns,0));const before=[...await list.listInfo(f.ns)],raw=[...await page.readWords(f.ns,0,3)];await assert.rejects(transact(writer.positionThenAdvance(f.ns,4,0,['0x7fff0000000000000000000000000000',q(0),q(0)],1,{gasLimit})));assert.deepEqual([...await list.listInfo(f.ns)],before);assert.deepEqual([...await page.readWords(f.ns,0,3)],raw);for(const work of[0,9])await assert.rejects(writer.advance(f.ns,work));await assert.rejects(list.connect(contributor).advance(f.ns,1));
 });
 await t.test('changed geometry code is rejected before advancing',async()=>{await env.transport.request({method:'evm_setAccountCode',params:[await geometry.getAddress(),'0x00']});await assert.rejects(writer.advance(f.ns,1));});
});
