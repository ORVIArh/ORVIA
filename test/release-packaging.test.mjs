import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {CHECK_NAMES, GENERATED_EVIDENCE, inputInventory, buildInventory, evidenceInventory, canonical, sha256, digestFile, verifyValidation} from '../scripts/validation_inventory.mjs';
const project=process.cwd(),python=process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
function fixture(t){
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'orvia-packaging-')),root=path.join(parent,'orvia');
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 for(const name of ['contracts','test/contracts','reference','scripts','data','reports','build','docs'])fs.mkdirSync(path.join(root,name),{recursive:true});
 for(const [name,text]of Object.entries({'package.json':'{"name":"synthetic-packaging-fixture","version":"0.5.0","type":"module"}','package-lock.json':'{}','requirements-research.txt':'# fixture','contracts/A.sol':'pragma solidity ^0.8.26; contract A {}','test/probe.test.mjs':'// synthetic fixture','reference/vector.json':'[1]','data/input.json':'{"frozen":true}','docs/release.md':'Release note'}))fs.writeFileSync(path.join(root,name),text);
 for(const name of ['check.mjs','check_preparation.mjs','validation_inventory.mjs','package.py'])fs.copyFileSync(path.join(project,'scripts',name),path.join(root,'scripts',name));
 return root;
}
// Deliberately constructed metadata in an isolated temporary directory exercises
// structural integrity only. It is never emitted as a real project test result.
function metadataFixture(root){
 const inputs=inputInventory(root),sources=Object.fromEntries(Object.entries(inputs).filter(([name])=>name.endsWith('.sol')));
 fs.writeFileSync(path.join(root,'reports/compiled_sizes.json'),JSON.stringify({sources,compiler:'synthetic-test-only'}));
 fs.writeFileSync(path.join(root,'build/artifacts.json'),'{}');
 for(const name of GENERATED_EVIDENCE)fs.writeFileSync(path.join(root,name),'{"scope":"synthetic packaging test"}');
 const checks=CHECK_NAMES.map(name=>{const log=`reports/${name}.log`;fs.writeFileSync(path.join(root,log),'Synthetic packaging metadata fixture\n');return {name,passed:true,exitCode:0,log,logSha256:digestFile(root,log)};});
 writeSummary(root,{schemaVersion:2,status:'completed',passed:true,scope:'Synthetic packaging fixture, not executed scientific validation',projectVersion:'0.5.0',requiredChecks:CHECK_NAMES,checks,inputInventory:inputs,inputInventorySha256:sha256(canonical(inputs)),buildOutputs:buildInventory(root),generatedEvidence:evidenceInventory(root)});
}
function runFixed(root,options={}){
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const code=`import {runChecks} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/check.mjs')).href)};runChecks(${JSON.stringify({root,...options})});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',env});
 assert.equal(result.status,0,result.stderr);return summary(root);
}
function packageResult(root){return spawnSync(python,['scripts/package.py'],{cwd:root,encoding:'utf8'});}
function summary(root){return JSON.parse(fs.readFileSync(path.join(root,'reports/validation_summary.json')));}
function writeSummary(root,value){fs.writeFileSync(path.join(root,'reports/validation_summary.json'),JSON.stringify(value));}

test('Release integrity binds exact inputs, compiler artifacts, numerical evidence and nine logs',async t=>{
 const root=fixture(t);metadataFixture(root);const valid=fs.readFileSync(path.join(root,'reports/validation_summary.json'));
 assert.equal(verifyValidation(root).passed,true);assert.equal(packageResult(root).status,0);
 for(const name of ['contracts/A.sol','test/probe.test.mjs','reference/vector.json','scripts/package.py','data/input.json','package-lock.json']){
  const target=path.join(root,name),before=fs.readFileSync(target);fs.appendFileSync(target,'\nchanged');
  assert.equal(verifyValidation(root).passed,false,name);assert.notEqual(packageResult(root).status,0,name);fs.writeFileSync(target,before);
 }
 for(const directory of ['contracts','test','reference','scripts','data']){
  const target=path.join(root,directory,'added.fixture');fs.writeFileSync(target,'new unchecked input');
  assert.equal(verifyValidation(root).passed,false,directory);fs.unlinkSync(target);
 }
 const target=path.join(root,'reference/vector.json'),before=fs.readFileSync(target);fs.unlinkSync(target);
 assert.equal(verifyValidation(root).passed,false);assert.notEqual(packageResult(root).status,0);fs.writeFileSync(target,before);
 for(const name of ['reports/compiled_sizes.json','build/artifacts.json','reports/evm_components.log','reports/mbar_validation.json','reports/deployment_rehearsal.json']){
  const p=path.join(root,name),original=fs.readFileSync(p);fs.appendFileSync(p,'\n');
  assert.equal(verifyValidation(root).passed,false,name);assert.notEqual(packageResult(root).status,0,name);fs.writeFileSync(p,original);
 }
 for(const mutation of [s=>s.checks.pop(),s=>s.checks[1].passed=false,s=>s.status='in_progress',s=>delete s.inputInventory,s=>s.schemaVersion=1]){
  const s=JSON.parse(valid);mutation(s);writeSummary(root,s);assert.equal(verifyValidation(root).passed,false);assert.notEqual(packageResult(root).status,0);
 }
 fs.writeFileSync(path.join(root,'reports/validation_summary.json'),valid);
 fs.appendFileSync(path.join(root,'docs/release.md'),' updated note');
 for(const file of ['reports/mainnet_readiness.json','reports/preflight.json','data/production_acceptance.json','data/operator_deployment.json','data/production_slot_evidence.json','data/production/execution.json']){
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'{}');
 }
 fs.writeFileSync(path.join(root,'reports/RELEASE_REVIEW_v0_5.md'),'New review');
 assert.equal(verifyValidation(root).passed,true);assert.equal(packageResult(root).status,0);
});

test('An interrupted rerun invalidates prior success and injected commands cannot certify a run',async t=>{
 const root=fixture(t);metadataFixture(root);
 assert.equal(runFixed(root,{checks:CHECK_NAMES.map(n=>[n,process.execPath,['-e','']])}).passed,false);
 assert.equal(verifyValidation(root).passed,false);
 metadataFixture(root);assert.equal(runFixed(root).passed,false);assert.equal(verifyValidation(root).passed,false);
 fs.writeFileSync(path.join(root,'scripts/compile.mjs'),"process.kill(process.ppid,'SIGKILL');");metadataFixture(root);
 const code=`import {runChecks} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/check.mjs')).href)};runChecks({root:${JSON.stringify(root)}});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8'});
 assert.equal(result.signal,'SIGKILL');assert.equal(summary(root).status,'in_progress');assert.equal(summary(root).passed,false);
 assert.notEqual(packageResult(root).status,0);
});

test('Changes during a fixed-command run cannot yield accepted validation',async t=>{
 const root=fixture(t);
 const sources=Object.fromEntries(Object.entries(inputInventory(root)).filter(([name])=>name.endsWith('.sol')));
 fs.writeFileSync(path.join(root,'scripts/compile.mjs'),`import fs from 'node:fs';fs.appendFileSync('reference/vector.json',' changed during run');fs.writeFileSync('reports/compiled_sizes.json',${JSON.stringify(JSON.stringify({sources,compiler:'synthetic'}))});fs.writeFileSync('build/artifacts.json','{}');`);
 for(const file of ['scripts/validate_manifest.py','scripts/audit_structure.py','scripts/audit_pair_identity.py','scripts/audit_preparation.py','scripts/scientific_readiness.py','data/prepared_candidate/alternative_models/audit_public_models.py']){
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'# Synthetic isolated command fixture\n');
 }
 fs.writeFileSync(path.join(root,'test/probe.test.mjs'),`import fs from 'node:fs';for(const name of ${JSON.stringify(GENERATED_EVIDENCE)})fs.writeFileSync(name,'{}');`);
 fs.writeFileSync(path.join(root,'reference/test_fixture.py'),'import unittest\nclass Check(unittest.TestCase):\n def test_fixture(self):self.assertTrue(True)\n');
 fs.mkdirSync(path.join(root,'test/preparation'),{recursive:true});
 fs.writeFileSync(path.join(root,'test/preparation/test_fixture.py'),'import unittest\nclass Check(unittest.TestCase):\n def test_fixture(self):self.assertTrue(True)\n');
 const result=runFixed(root);assert.equal(result.checks.length,9);assert.equal(result.passed,false);
 assert.ok(result.integrityErrors?.some(x=>x.includes('input')),JSON.stringify({status:result.status,error:result.error,checks:result.checks}));assert.notEqual(packageResult(root).status,0);
});
