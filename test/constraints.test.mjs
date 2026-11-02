import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AbiCoder, encodeBytes32String, keccak256, toUtf8Bytes, ZeroHash } from 'ethers';
import { environment, deploy, transact, quadFromNumber as q, qvec, quadToNumber as n } from './helpers.mjs';

const gasLimit = 28_000_000;
const source = keccak256(toUtf8Bytes('ORVIA synthetic coupled-constraint input'));
const hash = s => keccak256(toUtf8Bytes(s));
const python = process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';

test('Bounded coupled SHAKE and RATTLE solver', async t => {
  const { transport, provider, owner, contributor } = await environment();
  t.after(() => transport.disconnect());
  const math = await deploy('FloatMath', owner);
  const kernel = await deploy('DistanceConstraintKernel', owner, [await math.getAddress()]);
  const writer = await deploy('ConstraintHarness', owner);
  const solver = await deploy('ConstraintSolver', owner, [await writer.getAddress(), await math.getAddress(), await kernel.getAddress()]);
  await transact(writer.bind(await solver.getAddress()));
  const anchors = [[0,0,0],[1,0,0],[0,1,0]].map(qvec);
  const trials = [[.02,-.01,.005],[1.04,.03,-.008],[-.04,1.02,.01]].map(qvec);
  const masses = [16,1,1].map(q);
  const sqrt2 = await math.sqrt(q(2));
  const constraints = [[0,1,q(1)],[0,2,q(1)],[1,2,sqrt2]];
  const atoms = trials.map((current,i) => [anchors[i],current,masses[i]]);
  const tolerance = q(1e-20);
  const receipts = [];
  const positionId = hash('position-main'), velocityId = hash('velocity-main');
  const snapshot = async id => ({info:[...await solver.problemInfo(id)], atoms:await Promise.all(
    Array.from({length: Number((await solver.problemInfo(id)).loadedAtoms)},async(_,i)=>{
      const a=await solver.atomAt(id,i);return {anchor:[...a.anchor],current:[...a.current],mass:a.mass};
    }))});
  async function setup(id, mode=0, values=atoms, terms=constraints, limit=128, tol=tolerance) {
    await transact(writer.create(id,source,mode,values.length,terms.length,tol,limit));
    for(let i=0;i<values.length;i+=8) await transact(writer.atoms(id,values.slice(i,i+8)));
    for(let i=0;i<terms.length;i+=8) await transact(writer.constraints(id,terms.slice(i,i+8)));
    await transact(writer.seal(id));
  }
  async function advance(id,work) {
    const r=await transact(solver.connect(contributor).advance(id,work,{gasLimit}));
    receipts.push({id,work,gas:r.gasUsed.toString()});
  }
  async function finish(id,schedule=[8]) {
    for(let call=0;call<1000;call++) {
      const i=await solver.problemInfo(id);
      if(i.status===4n||i.status===5n)return i;
      await advance(id,schedule[call%schedule.length]);
    }
    assert.fail('Constraint work exceeded test bound');
  }
  let positions, velocities;

  await t.test('kernel mass-weighted projections match independent scalar roots and tangent projection',async()=>{
    const old=qvec([1,.2,-.1]),trial=qvec([1.01,.22,-.08]),target=q(1.03);
    const p=await kernel.positionCorrection([old,trial,q(12),q(1),target]);
    const v=await kernel.velocityCorrection([old,qvec([.02,.03,-.04]),q(12),q(1)]);
    const code=String.raw`
import json,sys,mpmath as m
m.mp.dps=90
d=json.load(sys.stdin)
def q(s):
 b=int(s,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 return (-1 if b>>127 else 1)*(m.mpf(f)*m.power(2,-16494) if e==0 else (1+m.mpf(f)/2**112)*m.power(2,e-16383))
old=list(map(q,d['old']));trial=list(map(q,d['trial']));target=q(d['target'])
dot=lambda a,b:sum(x*y for x,y in zip(a,b))
lam=m.findroot(lambda z:dot([trial[i]-z*old[i] for i in range(3)],[trial[i]-z*old[i] for i in range(3)])-target**2,0)
expected=[[lam*x/13 for x in old],[-12*lam*x/13 for x in old]]
rv=list(map(q,d['relativeVelocity']));scale=dot(old,rv)/dot(old,old)
expectedv=[[scale*x/13 for x in old],[-12*scale*x/13 for x in old]]
maximum=m.mpf(0)
for actual,reference in [(d['position'][:2],expected),(d['velocity'][:2],expectedv)]:
 for aa,rr in zip(actual,reference):
  for a,r in zip(aa,rr):
   error=abs(q(a)-r);maximum=max(maximum,error)
   assert error <= m.mpf('1e-29')+m.mpf('1e-28')*abs(r),(error,a,r)
print(json.dumps({'passed':True,'scalar_values':12,'maximum_absolute_error':str(maximum)}))
`;
    const result=JSON.parse(execFileSync(python,['-c',code],{input:JSON.stringify({old,trial,target,
      relativeVelocity:qvec([.02,.03,-.04]),position:[...p].map(x=>Array.isArray(x)?[...x]:x),velocity:[...v].map(x=>Array.isArray(x)?[...x]:x)}),encoding:'utf8'}));
    assert.equal(result.passed,true);
    await assert.rejects(kernel.positionCorrection([qvec([1,0,0]),qvec([0,1,0]),q(1),q(1),q(1)]));
    await assert.rejects(kernel.positionCorrection([qvec([1,0,0]),qvec([1,2,0]),q(1),q(1),q(1)]));
    await assert.rejects(kernel.velocityCorrection([qvec([0,0,0]),qvec([1,0,0]),q(1),q(1)]));
    await assert.rejects(kernel.positionCorrection([old,trial,q(0),q(1),target]));
  });

  await t.test('coupled three-atom water-mass position constraints require complete checking passes',async()=>{
    await setup(positionId);
    await assert.rejects(solver.solutionAt(positionId,0));
    await advance(positionId,3);
    let info=await solver.problemInfo(positionId);
    assert.equal(info.status,3n);assert.equal(info.iterations,0n);
    await assert.rejects(solver.solutionAt(positionId,0));
    await advance(positionId,3);
    info=await solver.problemInfo(positionId);
    assert.equal(info.status,2n);assert.equal(info.iterations,1n);
    assert.ok(n(info.maximumResidual)>n(tolerance));
    info=await finish(positionId);
    assert.equal(info.status,4n);assert.ok(info.iterations>1n);
    positions=await Promise.all([0,1,2].map(async i=>[...await solver.solutionAt(positionId,i)]));
    for(let i=0;i<3;i++) assert.ok(await math.compare(await solver.residualAt(positionId,i),tolerance)<=0n);
    await assert.rejects(solver.advance(positionId,1));
    await assert.rejects(writer.atoms(positionId,[atoms[0]]));
    await assert.rejects(writer.seal(positionId));
  });

  await t.test('RATTLE velocity constraints preserve mass-weighted momentum and converge independently',async()=>{
    const initial=[[.01,-.02,.005],[.1,.03,-.01],[-.04,.12,.02]].map(qvec);
    const values=initial.map((v,i)=>[positions[i],v,masses[i]]);
    await setup(velocityId,1,values,constraints.map(([a,b])=>[a,b,q(0)]));
    const info=await finish(velocityId);
    assert.equal(info.status,4n);
    velocities=await Promise.all([0,1,2].map(async i=>[...await solver.solutionAt(velocityId,i)]));
    const code=String.raw`
import json,sys,mpmath as m
m.mp.dps=90;d=json.load(sys.stdin)
def q(s):
 b=int(s,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 return (-1 if b>>127 else 1)*(m.mpf(f)*m.power(2,-16494) if e==0 else (1+m.mpf(f)/2**112)*m.power(2,e-16383))
vec=lambda xs:[list(map(q,x)) for x in xs]
old=vec(d['anchors']);trial=vec(d['trials']);actual=vec(d['positions']);mass=list(map(q,d['masses']))
terms=[(a,b,q(r)) for a,b,r in d['constraints']]
directions=[[old[b][i]-old[a][i] for i in range(3)] for a,b,_ in terms]
def candidate(ls):
 x=[r.copy() for r in trial]
 for z,(a,b,_),direction in zip(ls,terms,directions):
  for k in range(3):x[a][k]+=z*direction[k]/mass[a];x[b][k]-=z*direction[k]/mass[b]
 return x
def defects(*ls):
 x=candidate(ls)
 return tuple(sum((x[b][k]-x[a][k])**2 for k in range(3))-r*r for a,b,r in terms)
root=m.findroot(defects,(0,0,0),tol=m.mpf('1e-75'))
expected=candidate(root)
maximum=max(abs(actual[i][k]-expected[i][k]) for i in range(3) for k in range(3))
assert maximum < m.mpf('1e-18'),maximum
position_residual=max(abs(sum((actual[b][k]-actual[a][k])**2 for k in range(3))-r*r)/(r*r) for a,b,r in terms)
assert position_residual <= m.mpf('1.01e-20'),position_residual
for k in range(3):assert abs(sum(mass[i]*(actual[i][k]-trial[i][k]) for i in range(3))) < m.mpf('1e-29')
initial=vec(d['initialVelocity']);got=vec(d['velocities'])
J=m.matrix(3,9);inverse=m.diag([1/mass[i] for i in range(3) for _ in range(3)])
for row,(a,b,_) in enumerate(terms):
 for k in range(3):r=actual[b][k]-actual[a][k];J[row,3*a+k]=-r;J[row,3*b+k]=r
v=m.matrix([v for row in initial for v in row]);expectedv=v-inverse*J.T*m.lu_solve(J*inverse*J.T,J*v)
vmaximum=max(abs(got[i][k]-expectedv[3*i+k]) for i in range(3) for k in range(3))
assert vmaximum<m.mpf('1e-18'),vmaximum
for k in range(3):assert abs(sum(mass[i]*(got[i][k]-initial[i][k]) for i in range(3))) < m.mpf('1e-29')
velocity_residual=max(abs(sum((actual[b][k]-actual[a][k])*(got[b][k]-got[a][k]) for k in range(3)))/sum((actual[b][k]-actual[a][k])**2 for k in range(3)) for a,b,_ in terms)
assert velocity_residual<=m.mpf('1.01e-20'),velocity_residual
print(json.dumps({'scope':'Synthetic three-atom water-mass constraints, not a prepared water force field or integrated constrained trajectory','position_max_oracle_error':str(maximum),'velocity_max_oracle_error':str(vmaximum),'position_relative_squared_distance_residual':str(position_residual),'velocity_inverse_time_residual':str(velocity_residual),'passed':True},indent=2))
`;
    const output=execFileSync(python,['-c',code],{input:JSON.stringify({anchors,trials,positions,masses,constraints,initialVelocity:initial,velocities}),encoding:'utf8'});
    fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/constraints_validation.json',output+'\n');
    assert.equal(JSON.parse(output).passed,true);
  });

  await t.test('different transaction partitions and problem IDs give bitwise identical projected values',async()=>{
    const id=hash('position-partition');await setup(id);
    const done=await finish(id,[1,3,8,2]);
    assert.equal(done.status,4n);
    assert.equal(done.iterations,(await solver.problemInfo(positionId)).iterations);
    for(let i=0;i<3;i++)assert.deepEqual([...await solver.solutionAt(id,i)],positions[i]);
    assert.notEqual(done.commitment,(await solver.problemInfo(positionId)).commitment);
  });

  await t.test('maximum iterations produces immutable failure and never exposes a solution',async()=>{
    const id=hash('nonconvergence');await setup(id,0,atoms,constraints,1,q(1e-24));
    const info=await finish(id);
    assert.equal(info.status,5n);assert.equal(info.iterations,1n);
    await assert.rejects(solver.solutionAt(id,0));await assert.rejects(solver.advance(id,1));
    await assert.rejects(writer.atoms(id,[atoms[0]]));
  });

  await t.test('invalid later constraint reverts earlier same-transaction corrections without cross-problem writes',async()=>{
    const id=hash('local-failure'),values=[
      [qvec([0,0,0]),qvec([0,0,0]),q(16)],
      [qvec([1,0,0]),qvec([1.1,0,0]),q(1)],
      [qvec([0,1,0]),qvec([0,-1,0]),q(1)]];
    await setup(id,0,values,[[0,1,q(1)],[0,2,q(1)]]);
    const before=await snapshot(id),other=await snapshot(positionId);
    await assert.rejects(transact(solver.advance(id,2,{gasLimit})));
    assert.deepEqual(await snapshot(id),before);assert.deepEqual(await snapshot(positionId),other);
    await advance(id,1);
    const progressed=await snapshot(id);assert.notDeepEqual(progressed.atoms,before.atoms);
    await assert.rejects(transact(solver.advance(id,1,{gasLimit})));
    assert.deepEqual(await snapshot(id),progressed);
  });

  await t.test('input commitment is independently reconstructed and uploads reject malformed values atomically',async()=>{
    const addresses=await Promise.all([writer,math,kernel].map(x=>x.getAddress()));
    const codes=await Promise.all(addresses.map(x=>provider.getCode(x)));
    const abi=AbiCoder.defaultAbiCoder();
    const config=keccak256(abi.encode(['address','address','address','bytes32','bytes32','bytes32'],[...addresses,...codes.map(keccak256)]));
    assert.equal(await solver.configurationHash(),config);
    const id=hash('identity');await setup(id);
    let digest=keccak256(abi.encode(['bytes32','uint256','address','bytes32','bytes32','uint8','uint32','uint32','bytes16','uint32','bytes32'],
      [encodeBytes32String('ORVIA-CONSTRAINT-INPUT-v1'),31337,await solver.getAddress(),id,source,0,3,3,tolerance,128,config]));
    for(let i=0;i<3;i++)digest=keccak256(abi.encode(['bytes32','bytes32','uint256','tuple(bytes16[3],bytes16[3],bytes16)'],[digest,encodeBytes32String('ATOM'),i,atoms[i]]));
    for(let i=0;i<3;i++)digest=keccak256(abi.encode(['bytes32','bytes32','uint256','tuple(uint32,uint32,bytes16)'],[digest,encodeBytes32String('CONSTRAINT'),i,constraints[i]]));
    assert.equal(await solver.inputDigest(id),digest);
    const commitment=keccak256(abi.encode(['bytes32','bytes32','uint32','uint32'],[encodeBytes32String('ORVIA-CONSTRAINT-PROBLEM-v1'),digest,3,3]));
    assert.equal((await solver.problemInfo(id)).commitment,commitment);
    await assert.rejects(writer.create(id,source,0,3,3,tolerance,128));
    await assert.rejects(solver.createProblem(hash('unauthorized'),source,0,3,3,tolerance,128));
    await assert.rejects(solver.appendAtoms(id,[]));await assert.rejects(solver.sealProblem(id));
    const bad=hash('bad-input');await transact(writer.create(bad,source,0,3,3,tolerance,128));
    await assert.rejects(writer.seal(bad));
    const broken=structuredClone(atoms);broken[1][2]=q(0);
    await assert.rejects(transact(writer.atoms(bad,broken,{gasLimit})));
    assert.equal((await solver.problemInfo(bad)).loadedAtoms,0n);
    await transact(writer.atoms(bad,atoms));
    const before=await solver.inputDigest(bad);
    await assert.rejects(transact(writer.constraints(bad,[constraints[0],constraints[0]],{gasLimit})));
    assert.equal((await solver.problemInfo(bad)).loadedConstraints,0n);assert.equal(await solver.inputDigest(bad),before);
    await assert.rejects(writer.constraints(bad,[[1,0,q(1)]]));
    await assert.rejects(writer.constraints(bad,[[0,3,q(1)]]));
    await assert.rejects(writer.constraints(bad,[[0,1,q(-1)]]));
    await assert.rejects(writer.create(hash('zero-source'),ZeroHash,0,3,3,tolerance,128));
    await assert.rejects(writer.create(hash('zero-tol'),source,0,3,3,q(0),128));
    await assert.rejects(writer.create(hash('nonfinite-tol'),source,0,3,3,'0x7fff0000000000000000000000000000',128));
    await assert.rejects(solver.advance(bad,0));await assert.rejects(solver.advance(bad,9));
    await assert.rejects(solver.problemInfo(hash('missing')));
    await assert.rejects(solver.atomAt(positionId,3));
    await assert.rejects(deploy('ConstraintSolver',owner,[await owner.getAddress(),addresses[1],addresses[2]]));
    const vm=hash('velocity-payload');await transact(writer.create(vm,source,1,3,1,tolerance,128));
    await transact(writer.atoms(vm,atoms));await assert.rejects(writer.constraints(vm,[[0,1,q(1)]]));
  });

  fs.mkdirSync('reports',{recursive:true});
  fs.writeFileSync('reports/constraints_execution_gas.json',JSON.stringify({scope:'Local EVM reusable constraint solver only; no constrained molecular trajectory or Robinhood fee claim',chainId:31337,transactions:receipts},null,2)+'\n');
});
