import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {assessNativeFullModelDiagnostic,assertNativeFullModelAssessment} from './native_full_model_admission.mjs';
import {assessProtocol,assertReviewedAssessment,normalizeArtifactSpec} from './protocol_registry.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const archive=fs.readFileSync(path.join(root,'evidence/hybrid256/native-full-model-admission.tar.gz'));
const tar=gunzipSync(archive,{maxOutputLength:80*1024*1024});
const original=new Map();
for(let offset=0;offset+512<=tar.length;){
 const name=tar.subarray(offset,offset+100).toString().replace(/\0.*$/s,'');
 const size=parseInt(tar.subarray(offset+124,offset+136).toString().replace(/\0.*$/s,'').trim()||'0',8);
 const type=tar[offset+156];assert.ok(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length);
 if(type===48||type===0){if(name){assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));original.set(name,tar.subarray(offset+512,offset+512+size));}}
 offset+=512+Math.ceil(size/512)*512;
}
assert.ok(original.has('report.json'));
function fixture(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-native-admission-')),reportFile=path.join(dir,'report.json');
 try{for(const [name,bytes] of original){const p=path.join(dir,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);}
  const wrapper=JSON.parse(fs.readFileSync(reportFile));
  const save=()=>fs.writeFileSync(reportFile,JSON.stringify(wrapper));
  const change=(name,mutate)=>{const p=path.join(dir,name),r=JSON.parse(fs.readFileSync(p));mutate(r);const b=Buffer.from(JSON.stringify(r));fs.writeFileSync(p,b);wrapper.files[name]={bytes:b.length,sha256:sha(b)};save();};
  return fn({dir,reportFile,wrapper,save,change});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('actual two full native models admit exactly six retrospective diagnostic comparisons',()=>fixture(({reportFile})=>{
 const a=assessProtocol({protocol:'native-full-model-diagnostic-v1',reportFile});
 assert.equal(a.outcome,1);assert.equal(a.checks,7);assert.equal(a.completedSteps,'6');assert.match(a.counterUnit,/comparison cases/);
 assert.equal(a.diagnosticOnly,true);assert.equal(a.configuration.diagnosticOnly,true);assert.equal(a.scientificAcceptance,false);assert.equal(a.retrospective,true);assert.equal(a.metrics.length,6);
 assert.equal(assertReviewedAssessment(a),a);
}));
test('refuses source, engine, coordinate or checkpoint byte tampering',()=>fixture(({dir,reportFile})=>{
 for(const name of ['sources/model_repair_gpu_matched.py','environment/engine-build-report.json','checkpoints/complex33.chk','positions/solvent33.json']){
  const p=path.join(dir,name),bytes=fs.readFileSync(p);fs.appendFileSync(p,'!');assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}),/hash or length/);fs.writeFileSync(p,bytes);
 }
}));
test('refuses changed thresholds, model identities, source claims, hardware fallback or absent phases',()=>{
 for(const mutate of [r=>r.predeclared.comparison_tolerances.energy_absolute_kJ_mol=1,r=>r.inputs.particles++,r=>r.script_sha256='0'.repeat(64),r=>r.contexts.native_target.actual_platform='Reference',r=>delete r.final_comparison,r=>r.scientific_acceptance=true,r=>r.contexts.independent.actual_pme_alpha_and_grid[1]++,r=>r.engine.loaded_native_libraries[0].sha256='0'.repeat(64)]){
  fixture(({reportFile,change})=>{change('reports/complex33.json',mutate);assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}));});
 }
});
test('refuses inconsistent numerical flags, arithmetic and impossible force norm bounds',()=>{
 for(const mutate of [r=>r.post_nve_comparison.passed=false,r=>r.post_nve_comparison.target_energy_kJ_mol+=1,r=>r.post_nve_comparison.force_max_absolute_kJ_mol_nm=1e-12,r=>r.nve_diagnostic[9].energy_kJ_mol+=1]){
  fixture(({reportFile,change})=>{change('reports/complex33.json',mutate);assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}));});
 }
});
test('retains a truthful completed post-NVE strict failure as outcome 2, never promotes it',()=>fixture(({reportFile,change})=>{
 change('reports/complex33.json',r=>{const m=r.post_nve_comparison;m.force_max_absolute_kJ_mol_nm=.5;m.force_difference_L2=1;m.force_relative_L2=1/m.reference_force_L2;m.passed=false;r.passed=false;r.status='failed';r.error={type:'ValueError',message:'Post-NVE strict comparison failed'};});
 const a=assessNativeFullModelDiagnostic({reportFile});assert.equal(a.outcome,2);assert.equal(a.checks,3);assert.equal(a.completedSteps,'6');assert.equal(a.diagnosticOnly,true);assert.equal(a.scientificAcceptance,false);
}));
test('rejects symlink artifacts, extra/path-escaping members and false public evidence',()=>{
 fixture(({dir,reportFile})=>{const name=path.join(dir,'checkpoints/complex33.chk');fs.renameSync(name,name+'.old');fs.symlinkSync(name+'.old',name);assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}));});
 fixture(({wrapper,save,reportFile})=>{wrapper.files['../escape']={bytes:1,sha256:'0'.repeat(64)};save();assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}),/artifacts/);});
 fixture(({wrapper,save,reportFile})=>{wrapper.publicEvidence.inputs.url='https://example.com/';save();assert.throws(()=>assessNativeFullModelDiagnostic({reportFile}),/Public evidence/);});
});
test('fresh assessment is frozen and parsed substitutions cannot reach signing boundary',()=>fixture(({reportFile})=>{
 const a=assessNativeFullModelDiagnostic({reportFile});assert.equal(assertNativeFullModelAssessment(a),a);
 assert.throws(()=>{a.configuration.diagnosticOnly=false;},TypeError);assert.throws(()=>{a.metrics[0].passed=false;},TypeError);
 assert.throws(()=>assertNativeFullModelAssessment(JSON.parse(JSON.stringify(a))),/Fresh reviewed/);assert.throws(()=>assertReviewedAssessment({...a}),/Fresh reviewed/);
 assert.throws(()=>normalizeArtifactSpec({protocol:'native-full-model-diagnostic-v1',reportFile,skipChecks:true}));
}));
