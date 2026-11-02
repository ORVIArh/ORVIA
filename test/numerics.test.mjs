import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { environment,deploy,qvec,quadFromNumber as q,quadToNumber } from './helpers.mjs';

test('Binary128-format arithmetic and harmonic force component',async t=>{
  const env=await environment();
  t.after(()=>env.transport.disconnect());
  const math=await deploy('FloatMath',env.owner);
  const kernel=await deploy('HarmonicBondKernel',env.owner,[await math.getAddress()]);
  await t.test('matches seven independently generated 100-digit Decimal reference vectors',async()=>{
    const reference=JSON.parse(fs.readFileSync('reference/harmonic_bond_vectors.json','utf8'));
    const actual=[];
    for(const v of reference.vectors){
      const [energy,force]=await kernel.evaluate(v.a,v.b,v.k,v.r0);
      actual.push({name:v.name,energy,force:[...force],expected:v.expected});
    }
    const python=String.raw`
import sys,json
from decimal import Decimal as D, localcontext
p=json.load(sys.stdin)
def decode(h):
 b=int(h,16); e=(b>>112)&32767; f=b&((1<<112)-1)
 if e==32767: raise ValueError('nonfinite')
 return (-1 if b>>127 else 1)*((D(1)+D(f)/D(2)**112)*D(2)**(e-16383) if e else D(f)*D(2)**(-16382-112))
report=[]
with localcontext() as ctx:
 ctx.prec=160
 for v in p:
  values=[v['energy']]+v['force']
  expected=[v['expected']['energy_decimal']]+v['expected']['force_on_a_decimal']
  errors=[]
  for h,s in zip(values,expected):
   x=decode(h); y=D(s); err=abs(x-y); tol=D('1e-30')+D('1e-28')*abs(y)
   if err>tol: raise AssertionError((v['name'],str(x),s,str(err),str(tol)))
   errors.append(str(err))
  report.append({'name':v['name'],'absolute_errors':errors,'passed':True})
print(json.dumps({'reference':'Independent Python Decimal, 100 digits','arithmetic_format':'binary128, upstream ABDK semantics','comparison_absolute_tolerance':'1e-30','comparison_relative_tolerance':'1e-28','vectors':report},indent=2))
`;
    const report=execFileSync(process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3',['-c',python],{input:JSON.stringify(actual),encoding:'utf8'});
    fs.writeFileSync('reports/numerical_validation.json',report);
    assert.equal(JSON.parse(report).vectors.length,reference.vectors.length);
  });
  await t.test('force is negative energy gradient and transforms under translation',async()=>{
    const a=[0.5,-1,0.25],b=[2,1,3],k=q(7),r0=q(1.2),h=1e-5;
    const [energy,f]=await kernel.evaluate(qvec(a),qvec(b),k,r0);
    for(let axis=0;axis<3;axis++){
      const ap=[...a],am=[...a];ap[axis]+=h;am[axis]-=h;
      const ep=quadToNumber((await kernel.evaluate(qvec(ap),qvec(b),k,r0))[0]);
      const em=quadToNumber((await kernel.evaluate(qvec(am),qvec(b),k,r0))[0]);
      const fd=-(ep-em)/(2*h);
      assert.ok(Math.abs(fd-quadToNumber(f[axis]))<1e-7);
    }
    const shifted=await kernel.evaluate(qvec(a.map(x=>x+4)),qvec(b.map(x=>x+4)),k,r0);
    assert.equal(shifted[0],energy);
    assert.deepEqual([...shifted[1]],[...f]);
  });
  await t.test('rejects nonfinite input, invalid domains and zero separation',async()=>{
    const inf='0x7fff0000000000000000000000000000',nan='0x7fff8000000000000000000000000000';
    assert.equal(await math.isFinite(inf),false);
    assert.equal(await math.isFinite(nan),false);
    await assert.rejects(math.add(inf,q(1)));
    await assert.rejects(math.div(q(1),q(0)));
    await assert.rejects(math.sqrt(q(-1)));
    await assert.rejects(math.mul('0x7ffeffffffffffffffffffffffffffff',q(2)));
    await assert.rejects(kernel.evaluate(qvec([0,0,0]),qvec([0,0,0]),q(1),q(1)));
    await assert.rejects(kernel.evaluate(qvec([0,0,0]),qvec([1,0,0]),q(-1),q(1)));
  });
  await t.test('binary64 inspection round-trip and exact elementary identities',async()=>{
    for(const x of [0,1,-2.5,0.125,1e-250,1e250,Number.MIN_VALUE]){
      const b=Buffer.alloc(8);b.writeDoubleBE(x);
      const hex='0x'+b.toString('hex');
      assert.equal(await math.toDouble(await math.fromDouble(hex)),hex);
    }
    assert.equal(await math.add(q(1.5),q(2.5)),q(4));
    assert.equal(await math.mul(q(-2),q(3)),q(-6));
    assert.equal(await math.div(q(6),q(4)),q(1.5));
    assert.equal(await math.sqrt(q(9)),q(3));
    assert.equal(await math.fromInt(-7),q(-7));
    assert.equal(await math.fromUInt(11),q(11));
  });
  await t.test('signed zeros compare equally and arithmetic canonicalizes them',async()=>{
    const minusZero='0x80000000000000000000000000000000';
    assert.equal(await math.isZero(minusZero),true);
    assert.equal(await math.isNegative(minusZero),false);
    for(const x of [minusZero,q(0)]) {
      assert.equal(await math.compare(x,minusZero),0n);
      assert.equal(await math.compare(x,q(0)),0n);
      assert.equal(await math.compare(x,q(1)),-1n);
      assert.equal(await math.compare(x,q(-1)),1n);
      assert.equal(await math.sqrt(x),q(0));
      assert.equal(await math.neg(x),q(0));
      assert.equal(await math.mul(x,q(-2)),q(0));
      await assert.rejects(math.div(q(1),x));
    }
  });
});
