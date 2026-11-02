import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {AbiCoder, keccak256, id} from 'ethers';
import {environment, deploy, quadFromNumber as q, quadToNumber as number, qvec} from './helpers.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.ORVIA_RESEARCH_PYTHON || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
const zero = q(0), nan = '0x7fff8000000000000000000000000000';
const seed=id('ORVIA fixed stochastic fixture'), experiment=id('test experiment');
const abi=AbiCoder.defaultAbiCoder();

function expectedWord(replica,step,draw,lane) {
  return keccak256(abi.encode(['bytes32','bytes32','bytes32','uint32','uint64','uint64','uint8'],
    [id('ORVIA.CounterRandom.v1'),seed,experiment,replica,step,draw,lane]));
}
function midpointHex(word) {
  const n=2n*(BigInt(word)>>144n)+1n;
  const top=BigInt(n.toString(2).length-1);
  const exponent=top-113n+16383n;
  const fraction=(n-(1n<<top))<<(112n-top);
  return '0x'+((exponent<<112n)|fraction).toString(16).padStart(32,'0');
}

test('Bounded scalar functions, deterministic counter streams and BAOAB primitives',async t=>{
  const {owner,transport}=await environment();
  t.after(()=>transport.disconnect());
  const math=await deploy('FloatMath',owner), elementary=await deploy('ElementaryMath',owner,[await math.getAddress()]);
  const scalar=await deploy('ScalarMath',owner,[await math.getAddress()]);
  const random=await deploy('CounterRandom',owner,[await math.getAddress(),await scalar.getAddress(),await elementary.getAddress()]);
  const baoab=await deploy('LangevinBAOABKernel',owner,[await math.getAddress(),await scalar.getAddress()]);
  const observations={scalar:[],normal:[],baoab:[]};

  await t.test('scalar values span small increments, branch boundaries, normal logarithms and nonzero erfc tails',async()=>{
    const cases={
      ln:[q(2**-100),q(.125),q(.5),q(.75),q(1),q(1.125),q(2),q(10),q(2**100),'0x3fff0000000000000000000000000001','0x3ffeffffffffffffffffffffffffffff'],
      exp:[-256,-64,-4,-.5,-1e-20,0,1e-20,.5,4,64,256].map(q),
      expm1:[-256,-1,-.5,-1e-30,0,1e-30,.5,1,256].map(q),
      log1p:[-.75,-.5,-1e-30,0,1e-30,.5,1,256].map(q),
      erf:[-16,-4,-2,-1,-1e-30,0,1e-30,.125,1,1.5,2,2.125,4,8,16].map(q),
      erfc:[-16,-4,-2,-1,0,.125,1,1.5,1.999,2,2.001,3,4,8,12,16].map(q)
    };
    for(const [method,inputs]of Object.entries(cases)) for(const input of inputs){
      const output=await scalar[method](input);
      observations.scalar.push({method,input,output});
    }
    assert.notEqual(await scalar.erfc(q(16)),zero);
    assert.equal(await scalar.erf(zero),zero);
    assert.equal(await scalar.erfc(zero),q(1));
  });

  await t.test('counter words and strict-open uniforms equal independent domain encoding in arbitrary request order',async()=>{
    const keys=[];
    for(let i=0;i<24;i++)keys.push([i%3,BigInt(i*17),BigInt(23-i)]);
    const found=new Set();
    for(const [r,s,d]of keys){
      const expected=expectedWord(r,s,d,0);
      assert.equal(await random.word(seed,experiment,r,s,d,0),expected);
      const actual=await random.uniform(seed,experiment,r,s,d);
      assert.equal(actual,midpointHex(expected));
      assert.ok(number(actual)>0&&number(actual)<1);
      found.add(actual);
    }
    assert.equal(found.size,keys.length);
    for(const [r,s,d]of keys.reverse())assert.equal(await random.uniform(seed,experiment,r,s,d),midpointHex(expectedWord(r,s,d,0)));
    const max=(1n<<64n)-1n;
    assert.equal(await random.uniform(seed,experiment,2**32-1,max,max),midpointHex(expectedWord(2**32-1,max,max,0)));
  });

  await t.test('Box-Muller normals match independent transcendental references and elementary distribution checks',async()=>{
    const values=[];
    for(let draw=0;draw<32;draw++){
      const output=[...await random.normalPair(seed,experiment,7,11,draw)];
      if(draw<12)observations.normal.push({uniform:[midpointHex(expectedWord(7,11,draw,0)),midpointHex(expectedWord(7,11,draw,1))],output});
      values.push(...output.map(number));
    }
    const mean=values.reduce((a,b)=>a+b,0)/values.length;
    const variance=values.reduce((a,b)=>a+(b-mean)**2,0)/values.length;
    assert.ok(Math.abs(mean)<.25,`normal mean ${mean}`);
    assert.ok(variance>.65&&variance<1.4,`normal variance ${variance}`);
    const first=[...await random.normalPair(seed,experiment,7,11,0)];
    assert.deepEqual(first,observations.normal[0].output);
    assert.notDeepEqual(first,[...await random.normalPair(seed,experiment,8,11,0)]);
    observations.distribution={samples:values.length,mean,variance,note:'Small deterministic sanity fixture, not a general RNG-quality certification.'};
  });

  await t.test('BAOAB one-atom updates match independent splitting equations and retain tiny-friction noise',async()=>{
    for(const friction of [0,1e-30,.5,4,256]){
      const input={position:qvec([.5,-.25,1]),velocity:qvec([.125,-.5,.75]),force:qvec([1,-2,.5]),normal:qvec([-.5,1,.25]),newForce:qvec([-.25,1,.5]),parameters:[q(12),q(.125),q(friction),q(2.5)]};
      const coefficients=[...await baoab.coefficients(...input.parameters)];
      const begin=(await baoab.begin(input.position,input.velocity,input.force,...input.parameters,input.normal)).map(x=>[...x]);
      const finish=[...await baoab.finish(begin[1],input.newForce,input.parameters[0],input.parameters[1])];
      observations.baoab.push({input,coefficients,begin,finish});
      if(friction===1e-30)assert.notEqual(coefficients[1],zero);
      if(friction===0){
        assert.equal(coefficients[0],q(1));assert.equal(coefficients[1],zero);
        const verlet=await deploy('VelocityVerletKernel',owner,[await math.getAddress()]);
        const expected=await verlet.drift(input.position,input.velocity,input.force,input.parameters[0],input.parameters[1]);
        assert.deepEqual(begin,expected.map(x=>[...x]));
      }
    }
  });

  await t.test('independent 110-digit oracle accepts all scalar, normal and thermostat observations',async()=>{
    const result=execFileSync(python,[path.join(project,'reference/scalar_random_reference.py')],{input:JSON.stringify(observations),encoding:'utf8'});
    const report=JSON.parse(result);report.distribution=observations.distribution;
    fs.writeFileSync('reports/scalar_random_validation.json',JSON.stringify(report,null,2)+'\n');
    assert.ok(report.scalar_values_checked>=140);
  });

  await t.test('unsupported domains and mismatched dependencies revert without clipping',async()=>{
    for(const method of ['ln','exp','expm1','log1p','erf','erfc'])await assert.rejects(scalar[method](nan));
    for(const value of [0,-1])await assert.rejects(scalar.ln(q(value)));
    for(const value of [-257,257]){await assert.rejects(scalar.exp(q(value)));await assert.rejects(scalar.expm1(q(value)));}
    for(const value of [-17,17]){await assert.rejects(scalar.erf(q(value)));await assert.rejects(scalar.erfc(q(value)));}
    await assert.rejects(scalar.log1p(q(-1)));
    for(const params of [[0,1,1,1],[1,0,1,1],[1,1,-1,1],[1,1,1,0],[1,1,257,1]])await assert.rejects(baoab.coefficients(...params.map(q)));
    await assert.rejects(baoab.begin(qvec([0,0,0]),qvec([0,0,0]),qvec([0,0,0]),q(1),q(1),q(0),q(1),[nan,zero,zero]));
    const other=await deploy('FloatMath',owner);
    await assert.rejects(deploy('CounterRandom',owner,[await other.getAddress(),await scalar.getAddress(),await elementary.getAddress()]));
    await assert.rejects(deploy('LangevinBAOABKernel',owner,[await other.getAddress(),await scalar.getAddress()]));
  });
});
