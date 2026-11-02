import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {assessPrecisionDiagnostic,assertPrecisionAssessment} from './precision_admission.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const archive=fs.readFileSync(path.join(root,'evidence/hybrid256/h200-precision-results.tar.gz'));
assert.equal(createHash('sha256').update(archive).digest('hex'),'030dea7f6c6e3e97d57a04e73acd09ab9c88937ba35072935e794834dad9134a');
const tar=gunzipSync(archive);let original;
for(let offset=0;offset+512<=tar.length;){
  const name=tar.subarray(offset,offset+100).toString().replace(/\0.*$/s,'');
  const size=parseInt(tar.subarray(offset+124,offset+136).toString().replace(/\0.*$/s,'').trim()||'0',8);
  if(name==='results/precision-diagnostics.json') original=JSON.parse(tar.subarray(offset+512,offset+512+size));
  offset+=512+Math.ceil(size/512)*512;
}
assert.ok(original,'Frozen raw GPU report exists in the verified archive');
function fixture(operation){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-precision-admission-'));
  const reportFile=path.join(directory,'report.json');
  try {const report=structuredClone(original);operation({report,reportFile,directory,save:()=>fs.writeFileSync(reportFile,JSON.stringify(report))});}
  finally {fs.rmSync(directory,{recursive:true,force:true});}
}

test('admits actual H200 report as 26 diagnostic comparisons, never full-model acceptance',()=>fixture(({save,reportFile})=>{
  save();const result=assessPrecisionDiagnostic({reportFile});
  assert.equal(result.outcome,1);assert.equal(result.checks,7);assert.equal(result.completedSteps,'26');
  assert.equal(result.diagnosticOnly,true);assert.equal(result.configuration.diagnosticOnly,true);
  assert.equal(result.scientificAcceptance,false);assert.equal(result.fullPeriodicModelValidation,false);
}));

test('refuses lying success flags and arithmetically inconsistent error summaries',()=>{
  fixture(({report,save,reportFile})=>{report.endpoints[0].scenarios[0].repaired.force_max_absolute_kJ_mol_nm=1;save();assert.throws(()=>assessPrecisionDiagnostic({reportFile}));});
  fixture(({report,save,reportFile})=>{report.endpoints[0].scenarios[0].repaired.target_energy_kJ_mol+=3;save();assert.throws(()=>assessPrecisionDiagnostic({reportFile}));});
});

test('does not admit changed tolerances, source, atom identity, missing minima or CPU fallback',()=>{
  const mutations=[
    r=>r.tolerances_predeclared.force_relative_L2=0.1,
    r=>r.source_sha256['precision_system.py']='0'.repeat(64),
    r=>r.endpoints[1].atoms=45,
    r=>delete r.endpoints[0].minimized_fixtures.native,
    r=>r.endpoints[0].platforms.repaired.name='Reference',
    r=>r.production_ready=true,
  ];
  for(const mutate of mutations)fixture(({report,save,reportFile})=>{mutate(report);save();assert.throws(()=>assessPrecisionDiagnostic({reportFile}));});
});

test('retains a genuine numerical failure as a failed diagnostic',()=>fixture(({report,save,reportFile})=>{
  const metric=report.endpoints[0].scenarios[0].repaired;
  metric.force_difference_L2=1;metric.force_max_absolute_kJ_mol_nm=0.5;
  metric.force_relative_L2=1/metric.reference_force_L2;metric.passed=false;
  report.endpoints[0].passed=false;report.passed=false;report.strict_cuda_acceptance=false;
  report.endpoints[0].status='failed_strict_tolerance';report.status='failed';
  save();const result=assessPrecisionDiagnostic({reportFile});
  assert.equal(result.outcome,2);assert.equal(result.checks,3);assert.equal(result.diagnosticOnly,true);
}));

test('retains an RMS-only trajectory failure with truthful failed status',()=>fixture(({report,save,reportFile})=>{
  const metric=report.endpoints[0].deterministic_short_trajectory.repaired;
  metric.position_RMS_difference_nm=2e-5;metric.passed=false;
  report.endpoints[0].passed=false;report.endpoints[0].status='failed_strict_tolerance';
  report.passed=false;report.strict_cuda_acceptance=false;report.status='failed';
  save();const result=assessPrecisionDiagnostic({reportFile});
  assert.equal(result.outcome,2);assert.equal(result.checks,3);
}));

test('refuses impossible norm bounds and contradictory success status',()=>{
  fixture(({report,save,reportFile})=>{
    const m=report.endpoints[0].scenarios[0].repaired;
    m.force_max_absolute_kJ_mol_nm=1e-12;m.force_difference_L2=1e-6;
    m.force_relative_L2=m.force_difference_L2/m.reference_force_L2;
    save();assert.throws(()=>assessPrecisionDiagnostic({reportFile}),/underlying norms/);
  });
  fixture(({report,save,reportFile})=>{
    report.status='failed';save();assert.throws(()=>assessPrecisionDiagnostic({reportFile}),/status contradicts/);
  });
});

test('freezes and brands fresh assessments so serialized objects cannot reach a signer',()=>fixture(({save,reportFile})=>{
  save();const result=assessPrecisionDiagnostic({reportFile});
  assert.equal(assertPrecisionAssessment(result),result);
  assert.throws(()=>{result.outcome=2;},TypeError);
  assert.throws(()=>{result.configuration.diagnosticOnly=false;},TypeError);
  assert.throws(()=>assertPrecisionAssessment(JSON.parse(JSON.stringify(result))),/Fresh reviewed/);
}));

test('rejects symlinked or oversized artifacts',()=>fixture(({save,reportFile,directory})=>{
  save();const link=path.join(directory,'linked.json');fs.symlinkSync(reportFile,link);
  assert.throws(()=>assessPrecisionDiagnostic({reportFile:link}));
  fs.writeFileSync(reportFile,Buffer.alloc(4*1024*1024+1));assert.throws(()=>assessPrecisionDiagnostic({reportFile}));
}));
