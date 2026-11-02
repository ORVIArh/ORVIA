#!/usr/bin/env node
// Portable adapter only. Historical executed runners remain byte-for-byte intact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const args=process.argv.slice(2);
const allowed=new Set(['--mixed','--compile-only','--native-only']);
for(const arg of args)if(!allowed.has(arg))throw new Error('Unsupported option: '+arg);
if(args.includes('--mixed')&&args.includes('--native-only'))throw new Error('--mixed and --native-only cannot be combined');
const mixed=args.includes('--mixed');
const original=mixed?'mixed-benchmark.mjs':'benchmark-primary-run.mjs';
const reportName=mixed?'mixed-benchmark-report.json':'benchmark-report.json';
const output=path.join(here,'replays',new Date().toISOString().replace(/[:.]/g,'-')+'-'+(mixed?'mixed':'primary'));
fs.mkdirSync(output,{recursive:true});
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const inputs=['candidate-preparation.json','baseline-sources.json','AlchemicalHamiltonianEvaluator.candidate.sol','outside-pair-input.json','cases/cases.json','cases/mixed-cases.json'];
const records=[];
for(const name of inputs){
  const bytes=fs.readFileSync(path.join(here,name));
  const destination=path.join(output,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes);
  records.push({path:name,sha256:sha(bytes),bytes:bytes.length});
}
const executedBytes=fs.readFileSync(path.join(here,original));
let adapted=executedBytes.toString('utf8');
const rootLine="const OUT=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(OUT,'../..');";
const requireLine="const require=createRequire(path.join(ROOT,'ORVIA/package.json'));";
const nativePath="path.join(ROOT,'output/gas-estimate/outside-pair-input.json')";
for(const value of [rootLine,requireLine,nativePath])assert.ok(adapted.includes(value),'Expected frozen path expression missing');
adapted=adapted.replace(rootLine,'const OUT=path.dirname(fileURLToPath(import.meta.url)),ROOT='+JSON.stringify(repo)+';')
  .replace(requireLine,"const require=createRequire(path.join(ROOT,'package.json'));")
  .replace(nativePath,"path.join(OUT,'outside-pair-input.json')");
const runner=path.join(output,'adapted-runner.mjs');fs.writeFileSync(runner,adapted);
const manifest={schema:'orvia.guarded-cutoff-portable-replay.v1',status:'in_progress',mixed,
  originalRunner:original,originalRunnerSha256:sha(executedBytes),adapterSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  adaptedRunnerSha256:sha(adapted),sourceInputs:records,output,wholeCurrentEngineValidated:false};
const save=()=>fs.writeFileSync(path.join(output,'replay-manifest.json'),JSON.stringify(manifest,null,2)+'\n');save();
console.log('Replay output:',path.relative(repo,output));
const result=spawnSync(process.execPath,[runner,...args.filter(x=>x!=='--mixed')],{stdio:'inherit',env:process.env});
manifest.exitCode=result.status;
if(result.status===0){
  const actual=JSON.parse(fs.readFileSync(path.join(output,reportName)));
  const historical=JSON.parse(fs.readFileSync(path.join(here,reportName)));
  for(const key of ['baselineInputSha256','candidateInputSha256'])assert.equal(actual.compilation[key],historical.compilation[key],'Frozen compiler input changed');
  manifest.compilationInputsMatchHistorical=true;
  manifest.status=args.includes('--compile-only')?'compile_smoke_passed_not_benchmarked':actual.status;
}else manifest.status='failed';
save();
process.exitCode=result.status??1;
