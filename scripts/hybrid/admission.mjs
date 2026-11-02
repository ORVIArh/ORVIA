import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {id} from 'ethers';
import {normalizeReport} from './attestation.mjs';

export const PHOSPHATE_EXPERIMENT_ID = id('ORVIA.PHOSPHATE.NATIVE_B.FORCE_BENCHMARK.v1');
export const PINNED_BUNDLE_MANIFEST_SHA256 = '646e40485cb8e7323a9d988b518970a1f125d074004ed3e92e82820814ffd0a9';
export const CHECKS = Object.freeze({INPUT_IDENTITY:1,CUDA_PROPERTIES:2,FINITE_FORCE_RUNS:4,ENDPOINT_TOLERANCES:8});
export const TOLERANCES = Object.freeze({energy_absolute_kJ_mol:0.01,force_max_absolute_kJ_mol_nm:0.05,force_relative_L2:5e-5,trajectory_position_RMS_nm:1e-5});
const EXPECTED = {complex33:{atoms:132935,constraints:120519},solvent33:{atoms:151505,constraints:151179}};
const PRECISIONS = ['mixed','double'];
const admitted = new WeakSet();
function freeze(value){if(value&&typeof value==='object'){for(const x of Object.values(value))freeze(x);Object.freeze(value);}return value;}
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const hash = value=>'0x'+sha(Buffer.from(canonical(value)));
const fail = message=>{throw new Error(message);};
const finite = n=>typeof n==='number'&&Number.isFinite(n);
const near = (a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));

export function canonical(value) {
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Nonfinite JSON number');return JSON.stringify(value);}
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  fail('Unsupported canonical JSON value');
}
function inside(root,relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..'||x==='.'))fail('Unsafe artifact path');
  const target=path.resolve(root,relative);if(!target.startsWith(root+path.sep))fail('Artifact escapes root');
  let cursor=root;for(const part of relative.split('/')){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())fail('Artifact symlink refused');}
  return target;
}
function rootPath(input) {const p=path.resolve(input);if(fs.lstatSync(p).isSymbolicLink()||!fs.statSync(p).isDirectory())fail('Regular artifact directory required');return fs.realpathSync(p);}
function file(root,name,max=256*1024*1024) {
  const target=inside(root,name),before=fs.statSync(target);if(!before.isFile()||before.size>max)fail('Invalid or oversized artifact: '+name);
  const bytes=fs.readFileSync(target),after=fs.statSync(target);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('Artifact changed while reading');
  return{bytes,sha256:sha(bytes),size:bytes.length};
}
function json(record) {const value=JSON.parse(record.bytes);canonical(value);if(!value||Array.isArray(value)||typeof value!=='object')fail('JSON object required');return value;}
function cuda(report,precision) {
  return report.actual_platform==='CUDA'&&report.actual_properties?.Precision===precision
    &&typeof report.actual_properties?.DeviceName==='string'&&report.actual_properties.DeviceName.includes('A100');
}
function metrics(value) {
  if(!value||!['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2'].every(k=>finite(value[k])&&value[k]>=0)
    ||!finite(value.reference_energy_kJ_mol)||!finite(value.target_energy_kJ_mol)||!finite(value.reference_force_L2)||value.reference_force_L2<0)return false;
  return Object.keys(TOLERANCES).filter(k=>!k.startsWith('trajectory')).every(k=>value[k]<=TOLERANCES[k]);
}
function endpointChecks(report,manifest) {
  if(report.schema_version!=='orvia.cuda-endpoint-validation.v1'||report.validator_sha256!==manifest.files['scripts/validate_endpoints.py'].sha256
    ||report.requested_platform!=='CUDA'||canonical(report.requested_precisions)!==canonical(PRECISIONS)
    ||canonical(report.tolerances_predeclared)!==canonical(TOLERANCES)||report.perturbation_seed!==9917
    ||report.perturbation_standard_deviation_nm!==0.002||report.production_ready!==false)fail('Endpoint validator identity/policy mismatch');
  if(!Array.isArray(report.endpoint_checks)||report.endpoint_checks.length!==2)fail('Endpoint record count mismatch');
  let accepted=true;
  for(const [i,name]of ['A','B'].entries()){
    const e=report.endpoint_checks[i];if(e.endpoint!==name||e.expected_atoms!==(name==='A'?41:44))fail('Endpoint identity mismatch');
    for(const f of ['system.xml','parameters.json'])if(e.input_sha256?.[f]!==manifest.files[`inputs/endpoints/${name}/${f}`].sha256)fail('Endpoint source hash mismatch');
    if(!Array.isArray(e.configurations)||e.configurations.length!==2)fail('Endpoint precision records missing');
    for(const [j,precision]of PRECISIONS.entries()){
      const c=e.configurations[j];if(c.requested_platform!=='CUDA'||c.requested_precision!==precision)fail('Endpoint precision mismatch');
      const complete=Array.isArray(c.scenarios)&&c.scenarios.length===9&&c.deterministic_short_trajectory&&c.target_minimized_fixture;
      let passed=false;
      if(complete){
        if(c.scenarios.some((m,k)=>m.scenario!==(k===0?'original':`perturbation_${k}`)))fail('Endpoint scenario order mismatch');
        const trajectory=c.deterministic_short_trajectory;
        if(trajectory.steps!==20||trajectory.dt_ps!==0.0002||trajectory.initial_velocities!=='zero')fail('Endpoint trajectory policy mismatch');
        if(c.target_minimized_fixture.maximum_iterations!==1000||c.target_minimized_fixture.force_tolerance_kJ_mol_nm!==1)fail('Endpoint minimization policy mismatch');
        passed=cuda(c,precision)&&c.scenarios.every(metrics)&&metrics(trajectory.final_comparison)
          &&finite(trajectory.position_RMS_difference_nm)&&trajectory.position_RMS_difference_nm>=0
          &&trajectory.position_RMS_difference_nm<=TOLERANCES.trajectory_position_RMS_nm&&metrics(c.target_minimized_fixture);
      }
      if(c.passed===true&&!passed)fail('Endpoint claims success unsupported by metrics');
      accepted&&=passed&&c.passed===true;
    }
  }
  if(report.strict_numerical_acceptance===true&&!accepted)fail('Endpoint acceptance contradicts metrics');
  return accepted&&report.strict_numerical_acceptance===true;
}
function forceChecks(report,leg,precision,manifest) {
  const expectation=EXPECTED[leg];
  if(report.schema!=='orvia.explicit-openmm-hardware-benchmark.v1'||report.script_sha256!==manifest.files['scripts/benchmark_system.py'].sha256
    ||report.requested_platform!=='CUDA'||report.requested_precision!==precision||report.mode!=='forces'
    ||report.production_ready!==false||report.scientific_acceptance!==false)fail('Force report identity mismatch');
  if(report.inputs){for(const f of ['system','positions'])if(report.inputs[f]?.sha256!==manifest.files[`inputs/full/${leg}/${f==='system'?'system.xml':'positions.json'}`].sha256)fail('Force input hash mismatch');
    if(report.inputs.particles!==expectation.atoms||report.inputs.constraints!==expectation.constraints)fail('Force model shape mismatch');}
  let passed=false;const hardware=cuda(report,precision);
  if(report.passed===true){
    const settings=report.settings;
    if(!report.inputs||settings?.warmup!==5||settings.steps!==20||settings.repeats!==3||settings.dt_fs!==1
      ||settings.integrator!=='verlet'||settings.velocity_temperature_k!==0||report.reference_test_mode!==false
      ||report.implicit_cpu_fallback!==false||report.ns_per_day!==null||report.integration_elapsed_seconds!==null
      ||report.simulated_ns!==0||report.measured_operations!==60||report.completed_operations_this_run!==65
      ||!Array.isArray(report.repeats)||report.repeats.length!==3)fail('Force benchmark schedule/semantics mismatch');
    const validState=x=>x?.all_finite===true&&finite(x.potential_kj_per_mol)
      &&finite(x.maximum_abs_force_kj_per_mol_nm)&&x.maximum_abs_force_kj_per_mol_nm>=0&&x.simulation_time_ps===0;
    if(!validState(report.initial_state))fail('Initial finite-state summary invalid');
    let sum=0;for(const [i,row]of report.repeats.entries()){
      if(row.repeat!==i||row.operations!==20||!finite(row.elapsed_seconds)||row.elapsed_seconds<=0||row.ns_per_day!==null
        ||!near(row.force_evaluations_per_second,20/row.elapsed_seconds)||!validState(row.finite_state))fail('Force repeat/timing/finite-state mismatch');sum+=row.elapsed_seconds;
    }
    if(!near(report.measured_elapsed_seconds,sum)||!near(report.force_evaluation_elapsed_seconds,sum)
      ||!near(report.force_evaluations_per_second,60/sum)||!finite(report.total_elapsed_seconds)
      ||report.total_elapsed_seconds+1e-8<sum||!hardware||report.hardware_execution_verified!==true)fail('Force performance or CUDA evidence mismatch');
    passed=true;
  }
  return{passed,hardware,completed:passed?60:0};
}

/** Strict consistency and identity admission for this diagnostic phosphate experiment.
 * JSON/hardware statements remain trusted worker evidence, not a hardware or physics proof.
 */
export function assessPhosphateBenchmark({bundleRoot,resultsRoot}) {
  const bundle=rootPath(bundleRoot),results=rootPath(resultsRoot),manifestRecord=file(bundle,'manifest.json');
  if(manifestRecord.sha256!==PINNED_BUNDLE_MANIFEST_SHA256)fail('Unreviewed benchmark manifest');
  const manifest=json(manifestRecord);
  if(manifest.scientific_acceptance!==false||manifest.production_ready!==false||manifest.original_ORVIA_001_replacement_approved!==false)fail('Bundle scientific identity mismatch');
  for(const [name,expected]of Object.entries(manifest.files)){
    const observed=file(bundle,name);if(observed.sha256!==expected.sha256||observed.size!==expected.bytes)fail('Bundle file hash/size mismatch: '+name);
  }
  const files={};let count=0;
  function collect(relative='') {for(const item of fs.readdirSync(path.join(results,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=relative?relative+'/'+item.name:item.name;if(item.isSymbolicLink())fail('Result symlink refused');
    if(item.isDirectory()){if(name.split('/').length>4)fail('Result directory depth exceeded');collect(name);}
    else {if(++count>256)fail('Too many result artifacts');const observed=file(results,name,64*1024*1024);files[name]={bytes:observed.size,sha256:observed.sha256};}
  }}collect();
  const read=name=>{if(!files[name])return null;const record=file(results,name,8*1024*1024);if(record.sha256!==files[name].sha256)fail('Result changed during admission');return json(record);};
  const summary=read('summary.json');if(!summary||summary.schema_version!=='orvia.cloud-gpu-benchmark-run.v1'
    ||summary.runner_sha256!==manifest.files['scripts/run_benchmark.py'].sha256||summary.requested_platform!=='CUDA'
    ||canonical(summary.requested_precisions)!==canonical(PRECISIONS)||summary.scientific_acceptance!==false||summary.production_ready!==false)fail('Worker summary identity mismatch');
  for(const step of summary.steps??[])if(step.report_sha256){if(!files[step.report_file]||files[step.report_file].sha256!==step.report_sha256)fail('Worker step report hash mismatch');}
  let checks=0;const failures=[];
  const claimedIdentity=summary.manifest_sha256===PINNED_BUNDLE_MANIFEST_SHA256
    &&Object.entries(manifest.files).every(([name,item])=>summary.input_and_script_sha256?.[name]===item.sha256);
  if(claimedIdentity)checks|=CHECKS.INPUT_IDENTITY;else failures.push('Worker did not finish manifest identity verification');
  const endpoints=read('endpoints.json');const endpointPassed=endpoints?endpointChecks(endpoints,manifest):false;
  if(endpointPassed)checks|=CHECKS.ENDPOINT_TOLERANCES;else failures.push('Strict endpoint numerical checks did not pass');
  let allForces=true,allHardware=true,completed=0;
  for(const leg of Object.keys(EXPECTED))for(const precision of PRECISIONS){const name=`forces-${leg}-${precision}.json`,value=read(name);if(!value){allForces=false;allHardware=false;failures.push('Missing '+name);continue;}
    const state=forceChecks(value,leg,precision,manifest);allForces&&=state.passed;allHardware&&=state.hardware;completed+=state.completed;if(!state.passed)failures.push('Force benchmark did not pass: '+leg+'/'+precision);
  }
  if(allHardware)checks|=CHECKS.CUDA_PROPERTIES;if(allForces)checks|=CHECKS.FINITE_FORCE_RUNS;
  if(summary.full_force_benchmarks_passed===true&&!allForces||summary.endpoint_strict_numerical_acceptance===true&&!endpointPassed
    ||summary.hardware_execution_verified===true&&(!allHardware||!allForces))fail('Summary success flags contradict underlying reports');
  const protocol={schema:'orvia.phosphate-hardware-diagnostic.v1',mode:'fixed_coordinates_forces',warmup:5,iterations:20,repeats:3,precisions:PRECISIONS,tolerances:TOLERANCES,requiredChecks:15,scientificAcceptance:false,originalVanadateReplacement:false};
  const modelHash=hash(Object.fromEntries(Object.keys(EXPECTED).map(leg=>[leg,manifest.files[`inputs/full/${leg}/system.xml`].sha256])));
  const inputHash=hash(Object.fromEntries(Object.keys(manifest.files).filter(k=>k.startsWith('inputs/')).map(k=>[k,manifest.files[k].sha256])));
  const softwareHash=hash(Object.fromEntries(Object.keys(manifest.files).filter(k=>k.startsWith('scripts/')).map(k=>[k,manifest.files[k].sha256])));
  const environmentHash=hash({platform:'CUDA',deviceNameContains:'A100',precisions:PRECISIONS,openmm:'8.6.1',source:'pinned benchmark scripts + runtime properties in results'});
  const artifactManifest={schema:'orvia.retrieved-worker-artifacts.v1',files};
  const configuration={protocolHash:hash(protocol),modelHash,inputHash,softwareHash,environmentHash,requiredChecks:15,allowedChecks:15,diagnosticOnly:true};
  const assessment={schema:'orvia.phosphate-worker-admission.v1',admissible:true,experimentId:PHOSPHATE_EXPERIMENT_ID,configuration,
    diagnosticOnly:true,scientificAcceptance:false,originalVanadateReplacement:false,checks,outcome:checks===15?1:2,
    completedSteps:String(completed),counterUnit:'measured fixed-coordinate force evaluations across the four leg/precision jobs; not MD steps',
    checkpointHash:inputHash,resultHash:hash(artifactManifest),runConfigHash:hash({protocol,inputHash,softwareHash,environmentHash}),
    artifactManifest,bundleManifestSha256:PINNED_BUNDLE_MANIFEST_SHA256,failures,
    trust:'Operator-attested worker files and consistency checks, not cryptographic GPU execution or scientific proof'};
  // Freeze current snapshot: refuse concurrent file additions/removals/changes.
  const names=Object.keys(files);for(const name of names)if(file(results,name,64*1024*1024).sha256!==files[name].sha256)fail('Result changed before admission completed');
  freeze(assessment);admitted.add(assessment);return assessment;
}

/** Fresh in-memory admission only: serialized flags are not authority. */
export function assertPhosphateAssessment(assessment) {
  if(!admitted.has(assessment)||assessment.experimentId!==PHOSPHATE_EXPERIMENT_ID||assessment.diagnosticOnly!==true)fail('Fresh reviewed phosphate assessment required');
  return assessment;
}

/** Builds an UNSIGNED report. The signing client must independently read the
 * actual coordinator runInfo, verify its configuration/lineage, and use current expiry.
 */
export function unsignedReport(assessment,{runId,configurationHash,sequence,previousCheckpointHash,validUntil}) {
  if(!admitted.has(assessment)||assessment?.admissible!==true||assessment.experimentId!==PHOSPHATE_EXPERIMENT_ID||assessment.diagnosticOnly!==true)fail('Reviewed diagnostic assessment required');
  return normalizeReport({runId,configurationHash,sequence,completedSteps:assessment.completedSteps,previousCheckpointHash,
    checkpointHash:assessment.checkpointHash,resultHash:assessment.resultHash,outcome:assessment.outcome,checks:assessment.checks,validUntil});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--bundle-root','--results-root','--output'].includes(args[i])||!args[i+1])fail('Expected --bundle-root DIR --results-root DIR --output FILE');options[args[i]]=args[i+1];}
  if(!options['--bundle-root']||!options['--results-root']||!options['--output'])fail('All three paths are required');
  const dest=path.resolve(options['--output']),source=rootPath(options['--results-root']);if(dest===source||dest.startsWith(source+path.sep))fail('Admission output must be outside result tree');
  const assessment=assessPhosphateBenchmark({bundleRoot:options['--bundle-root'],resultsRoot:source});fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(assessment,null,2)+'\n');console.log(JSON.stringify({admissible:assessment.admissible,diagnosticOnly:true,outcome:assessment.outcome,checks:assessment.checks,resultHash:assessment.resultHash,output:dest}));
}
