import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { environment, deploy, qvec, quadFromNumber as q, quadToNumber as number } from './helpers.mjs';

test('Softcore endpoints and Monte Carlo decisions have independent numerical references', async t => {
  const env=await environment(); t.after(()=>env.transport.disconnect());
  const math=await deploy('FloatMath',env.owner);
  const scalar=await deploy('ScalarMath',env.owner,[await math.getAddress()]);
  const soft=await deploy('SoftcoreLennardJonesKernel',env.owner,[await math.getAddress()]);
  const lj=await deploy('LennardJonesKernel',env.owner,[await math.getAddress()]);
  const mc=await deploy('MonteCarloAcceptance',env.owner,[await math.getAddress(),await scalar.getAddress()]);
  const a=qvec([.75,.5]),b=qvec([1,.25]);

  await t.test('softcore energies, forces and lambda derivatives match differentiated scalar energies',async()=>{
    const cases=[];
    for(const [d,lambda] of [[[1.25,.25,-.5],0],[[1.25,.25,-.5],1],[[1.25,.25,-.5],.25],[[0,0,0],.5],[[.125,-.25,.125],.875],[[2,1,-1],.5]]){
      const result=await soft.evaluate(qvec(d),[a,b,q(lambda),q(.5)]);
      cases.push({d:qvec(d),a,b,lambda:q(lambda),alpha:q(.5),actual:[result[0],...result[1],result[2]]});
    }
    const python=String.raw`
import json,sys,mpmath as mp
mp.mp.dps=100
def dec(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 v=mp.mpf(f if not e else (1<<112)+f)*mp.power(2,(-16382 if not e else e-16383)-112)
 return -v if b>>127 else v
records=[]
for c in json.load(sys.stdin):
 d=list(map(dec,c['d']));a=list(map(dec,c['a']));b=list(map(dec,c['b']));l=dec(c['lambda']);alpha=dec(c['alpha'])
 def energy(v,lam):
  r6=sum(x*x for x in v)**3
  def term(p,soft):
   s,e=p;t=r6+alpha*s**6*soft**2
   return 4*e*((s**6/t)**2-s**6/t)
  return (1-lam)*term(a,lam)+lam*term(b,1-lam)
 expected=[energy(d,l)]
 for axis in range(3):
  def vary(x):
   v=d[:];v[axis]=x;return energy(v,l)
  expected.append(mp.diff(vary,d[axis]))
 expected.append(mp.diff(lambda x:energy(d,x),l))
 errors=[abs(dec(x)-y) for x,y in zip(c['actual'],expected)]
 for error,y in zip(errors,expected):assert error<=mp.mpf('1e-28')+mp.mpf('1e-27')*abs(y),(error,y)
 records.append({'lambda':str(l),'maximum_absolute_error':mp.nstr(max(errors),90),'passed':True})
print(json.dumps({'scope':'Unswitched softcore LJ primitive, not a complete hybrid Hamiltonian','cases':records},indent=2))
`;
    const report=execFileSync(process.env.ORVIA_RESEARCH_PYTHON||'python3',['-c',python],{input:JSON.stringify(cases),encoding:'utf8'});
    fs.writeFileSync('reports/softcore_validation.json',report);
  });

  await t.test('endpoints recover ordinary LJ and exchanging endpoints reverses lambda derivative',async()=>{
    const d=qvec([1.25,.25,-.5]);
    for(const [lambda,p] of [[0,a],[1,b]]){
      const got=await soft.evaluate(d,[a,b,q(lambda),q(.5)]);
      const expected=await lj.evaluate(qvec([0,0,0]),d,...p);
      assert.ok(Math.abs(number(got[0])-number(expected[0]))<1e-14);
      for(let i=0;i<3;i++)assert.ok(Math.abs(number(got[1][i])-number(expected[1][i]))<1e-14);
    }
    const x=await soft.evaluate(d,[a,b,q(.25),q(.5)]),y=await soft.evaluate(d,[b,a,q(.75),q(.5)]);
    assert.equal(x[0],y[0]); assert.deepEqual([...x[1]],[...y[1]]);
    assert.equal(await math.neg(x[2]),y[2]);
  });

  await t.test('ghost zero strength stays finite while active singular endpoints and bad domains fail',async()=>{
    const zero=qvec([0,0,0]),ghost=qvec([.75,0]);
    const inactive=await soft.evaluate(zero,[ghost,b,q(0),q(.5)]);
    assert.equal(inactive[0],q(0)); assert.deepEqual([...inactive[1]],zero);
    await assert.rejects(soft.evaluate(zero,[a,b,q(0),q(.5)]));
    await assert.rejects(soft.evaluate(zero,[a,b,q(1),q(.5)]));
    for(const lambda of [-.01,1.01])await assert.rejects(soft.evaluate(qvec([1,0,0]),[a,b,q(lambda),q(.5)]));
    await assert.rejects(soft.evaluate(qvec([1,0,0]),[a,b,q(.5),q(0)]));
  });

  await t.test('replica decisions use four cross-state energies and stable log probabilities',async()=>{
    const favorable=await mc.replicaExchange(qvec([3,1,1,3]),q(.999));
    assert.equal(number(favorable[0]),4); assert.equal(favorable[1],true);
    const unfavorable=await mc.replicaExchange(qvec([1,3,3,1]),q(.5));
    assert.equal(number(unfavorable[0]),-4); assert.equal(unfavorable[1],false);
    assert.equal((await mc.replicaExchange(qvec([0,500,500,0]),q(2**-100)))[1],false);
    const offset=await mc.replicaExchange(qvec([103,101,-49,-47]),q(.999));
    assert.deepEqual([...offset],[...favorable]);
    for(const u of [0,1,-1])await assert.rejects(mc.replicaExchange(qvec([0,0,0,0]),q(u)));
  });

  await t.test('volume decisions include pressure work and the declared symmetric-volume Jacobian',async()=>{
    const evaluate=(oldU,newU,oldV,newV,p,kT,n,u)=>mc.volumeTrial([q(oldU),q(newU),q(oldV),q(newV),q(p),q(kT),n,q(u)]);
    const expansion=await evaluate(0,0,2,4,0,1,2,.9);
    assert.ok(Math.abs(number(expansion[0])-2*Math.log(2))<1e-14);assert.equal(expansion[1],true);
    const compression=await evaluate(0,0,4,2,0,1,2,.5);
    assert.ok(Math.abs(number(compression[0])+2*Math.log(2))<1e-14);assert.equal(compression[1],false);
    const work=await evaluate(1,3,2,4,2,2,2,.5);
    assert.ok(Math.abs(number(work[0])-(2*Math.log(2)-3))<1e-14);assert.equal(work[1],false);
    assert.equal((await evaluate(0,0,2,2,3,2,2,.999))[1],true);
    await assert.rejects(evaluate(0,0,0,2,0,1,2,.5));
    await assert.rejects(evaluate(0,0,1,2,0,1,0,.5));
    await assert.rejects(evaluate(0,0,1,2,-1,1,2,.5));
  });
});
