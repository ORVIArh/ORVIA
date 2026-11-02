import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { environment, deploy, qvec, quadFromNumber as q, quadToNumber } from './helpers.mjs';

const python = process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
const references = JSON.parse(fs.readFileSync('reference/angular_vectors.json','utf8'));
function compareReference(rows) {
  for (const row of rows) assert.equal(row.actual.length,row.expected.length,row.name);
  const program=String.raw`
import json,sys
from decimal import Decimal as D,localcontext
rows=json.load(sys.stdin)
def decode(h):
 b=int(h,16);e=(b>>112)&32767;f=b&((1<<112)-1)
 if e==32767:raise ValueError('Nonfinite output')
 return (-1 if b>>127 else 1)*(D(f)*D(2)**(-16382-112) if not e else D((1<<112)+f)*D(2)**(e-16383-112))
report=[]
with localcontext() as ctx:
 ctx.prec=160
 for row in rows:
  errors=[]
  for h,s in zip(row['actual'],row['expected']):
   actual=decode(h);expected=D(s);error=abs(actual-expected);tolerance=D('1e-29')+D('1e-27')*abs(expected)
   if error>tolerance:raise AssertionError((row['name'],str(actual),s,str(error),str(tolerance)))
   errors.append(str(error))
  report.append({'name':row['name'],'absolute_errors':errors,'passed':True})
print(json.dumps(report))
`;
  return JSON.parse(execFileSync(python,['-c',program],{input:JSON.stringify(rows),encoding:'utf8'}));
}

test('Bounded angular functions and angle/torsion energy-force components',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const math=await deploy('FloatMath',env.owner);
  const elementary=await deploy('ElementaryMath',env.owner,[await math.getAddress()]);
  const angle=await deploy('HarmonicAngleKernel',env.owner,[await math.getAddress(),await elementary.getAddress()]);
  const torsion=await deploy('PeriodicTorsionKernel',env.owner,[await math.getAddress(),await elementary.getAddress()]);
  const report=[];

  await t.test('atan2 and sine/cosine match independent 100-digit references',async()=>{
    const rows=[];
    for(let i=0;i<references.atan2.length;i++){
      const v=references.atan2[i];
      rows.push({name:`atan2_${i}`,actual:[await elementary.atan2(v.y,v.x)],expected:[v.expected]});
    }
    for(let i=0;i<references.sinCos.length;i++){
      const v=references.sinCos[i];
      rows.push({name:`sinCos_${i}`,actual:[...await elementary.sinCos(v.angle)],expected:[v.sin,v.cos]});
    }
    report.push(...compareReference(rows));
    assert.equal(await elementary.acos(q(1)),q(0));
    assert.equal(await elementary.acos(q(-1)),await elementary.PI());
    assert.equal(await elementary.acos(q(0)),await elementary.HALF_PI());
  });

  await t.test('all angle and torsion force components match independently differentiated scalar energies',async()=>{
    const rows=[];
    for(const v of references.angles){
      const result=await angle.evaluate(...v.positions,v.k,v.theta0);
      rows.push({name:v.name,actual:[result[0],...result.slice(1).flatMap(a=>[...a])],expected:[v.expected.energy,...v.expected.forces.flat()]});
    }
    for(const v of references.torsions){
      const result=await torsion.evaluate(...v.positions,v.periodicity,v.k,v.phase);
      rows.push({name:v.name,actual:[result[0],...result.slice(1).flatMap(a=>[...a])],expected:[v.expected.energy,...v.expected.forces.flat()]});
    }
    report.push(...compareReference(rows));
  });

  await t.test('energy gradients agree with forces evaluated by the contracts',async()=>{
    for(const [kernel,points,params,atom,axis] of [
      [angle,[[0.25,-1,0.5],[1,0.25,-0.5],[1.5,2,0.75]],[q(0.75),q(1.5)],0,2],
      [torsion,[[0,0,0],[1,0,0],[1.5,1,0.125],[2,1.25,1.125]],[2,q(0.125),q(0.25)],1,1]
    ]){
      const result=await kernel.evaluate(...points.map(qvec),...params);
      const plus=points.map(p=>[...p]),minus=points.map(p=>[...p]),h=1e-5;
      plus[atom][axis]+=h;minus[atom][axis]-=h;
      const ep=quadToNumber((await kernel.evaluate(...plus.map(qvec),...params))[0]);
      const em=quadToNumber((await kernel.evaluate(...minus.map(qvec),...params))[0]);
      assert.ok(Math.abs(-(ep-em)/(2*h)-quadToNumber(result[atom+1][axis]))<1e-7);
    }
  });

  await t.test('translation, reversal, total force and total torque preserve mechanical invariants',async()=>{
    for(const [kernel,v,params] of [
      [angle,references.angles[1],[references.angles[1].k,references.angles[1].theta0]],
      [torsion,references.torsions[1],[references.torsions[1].periodicity,references.torsions[1].k,references.torsions[1].phase]]
    ]){
      const p=v.positions.map(v=>v.map(quadToNumber));
      const original=await kernel.evaluate(...v.positions,...params);
      const translated=await kernel.evaluate(...p.map(v=>qvec(v.map(x=>x+4))),...params);
      assert.deepEqual([translated[0],...translated.slice(1).map(v=>[...v])],
        [original[0],...original.slice(1).map(v=>[...v])]);
      const reversed=await kernel.evaluate(...[...v.positions].reverse(),...params);
      assert.ok(Math.abs(quadToNumber(reversed[0])-quadToNumber(original[0]))<1e-12);
      const force=[0,0,0],torque=[0,0,0];
      for(let i=0;i<p.length;i++){
        const f=[...original[i+1]].map(quadToNumber),fr=[...reversed[p.length-i]].map(quadToNumber);
        for(let j=0;j<3;j++){
          force[j]+=f[j];assert.ok(Math.abs(f[j]-fr[j])<1e-12);
          torque[j]+=p[i][(j+1)%3]*f[(j+2)%3]-p[i][(j+2)%3]*f[(j+1)%3];
        }
      }
      for(const x of [...force,...torque])assert.ok(Math.abs(x)<1e-12);
    }
  });

  await t.test('invalid numerical domains and degenerate geometry reject explicitly',async()=>{
    const inf='0x7fff0000000000000000000000000000';
    await assert.rejects(elementary.atan2(q(0),q(0)));
    await assert.rejects(elementary.atan2(inf,q(1)));
    await assert.rejects(elementary.sinCos(q(101)));
    await assert.rejects(elementary.sinCos(inf));
    await assert.rejects(elementary.acos(q(1.01)));
    const collinear=[[0,0,0],[1,0,0],[2,0,0],[3,0,0]].map(qvec);
    await assert.rejects(angle.evaluate(...collinear.slice(0,3),q(1),q(1)));
    await assert.rejects(angle.evaluate(qvec([0,1,0]),...collinear.slice(0,2),q(-1),q(1)));
    await assert.rejects(angle.evaluate(qvec([0,1,0]),...collinear.slice(0,2),q(1),q(4)));
    await assert.rejects(torsion.evaluate(...collinear,1,q(1),q(0)));
    const v=references.torsions[0];
    for(const n of [0,7])await assert.rejects(torsion.evaluate(...v.positions,n,q(1),q(0)));
    await assert.rejects(torsion.evaluate(...v.positions,1,q(-1),q(0)));
    await assert.rejects(torsion.evaluate(...v.positions,1,q(1),q(7)));
    const otherMath=await deploy('FloatMath',env.owner);
    await assert.rejects(deploy('HarmonicAngleKernel',env.owner,[await otherMath.getAddress(),await elementary.getAddress()]));
    await assert.rejects(deploy('PeriodicTorsionKernel',env.owner,[await otherMath.getAddress(),await elementary.getAddress()]));
  });

  fs.writeFileSync('reports/angular_validation.json',JSON.stringify({
    scope:'Bounded numerical/component tests only; no complete molecular force field or production error budget.',
    reference:'mpmath 1.3.0 at 100 digits, independent scalar energies and differentiated forces',
    absoluteTolerance:'1e-29',relativeTolerance:'1e-27',cases:report
  },null,2)+'\n');
});
