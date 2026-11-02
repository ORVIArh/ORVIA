// Retrospective operator attestation of six native-B numerical comparisons.
// This is neither scientific campaign acceptance nor proof of GPU execution.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {id} from 'ethers';
import {canonical} from './admission.mjs';

export const NATIVE_FULL_MODEL_EXPERIMENT_ID=id('ORVIA.PHOSPHATE_V03_NATIVE_B_FULL_MODEL_DIAGNOSTIC.v1');
const SHA=/^[0-9a-f]{64}$/;
const must=(ok,message)=>{if(!ok)throw new Error(message);};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>'0x'+sha(canonical(x));
const same=(a,b)=>canonical(a)===canonical(b);
const near=(a,b)=>Math.abs(a-b)<=1e-12+1e-7*Math.max(Math.abs(a),Math.abs(b));
const branded=new WeakSet();
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
const SOURCES=freeze({'model_repair_gpu_matched.py':'7e0472837473ac9aa75a16d7f833784c522a90e57a240380650f5c99d4772151','model_repair_gpu.py':'eba57e88be1549e43d0f6566bc0416b5d984bd405337617d56a7f3ab127ac199'});
const BUILD='82f3560f4ff7e0b780b65608f50d188e85d12a08b7bd5c14fba82d8236833f4f';
const GRID=freeze([2.628260884878466,96,90,100]);
const LIMITS=freeze({energy_absolute_kJ_mol:0.01,force_max_absolute_kJ_mol_nm:0.05,force_relative_L2:5e-5});
const POLICY=freeze({restraint_k_kJ_mol_nm2_and_max_iterations:[[1000,200],[100,200],[0,400]],minimizer_force_tolerance_kJ_mol_nm:10,force_margin_kJ_mol_nm:67108864,comparison_tolerances:LIMITS,nve_steps:10,nve_dt_fs:0.1});
const INPUTS=freeze({
  complex33:{system_sha256:'13939620df9a6c18ae249afa4add4e442b6004eadfc641d9078bcd45a798cc93',positions_sha256:'55366f20dab76493f67fd465f1cf88d2aa740c932cb080b1ef1730b96436d1c7',particles:132935,constraints:120519,configured:'b7b46d49ffaf09ea0b0d89243af5598596592ccf86bc63f1fc1595d50486c14d',force_index:4,force_types:['HarmonicBondForce','HarmonicAngleForce','PeriodicTorsionForce','CustomNonbondedForce','NonbondedForce']},
  solvent33:{system_sha256:'e7927eda87abc0a7380cd6969b54f9e0c2c6f3a6ee5f85b5f61ccab4266af2c3',positions_sha256:'f9425cc8ce73ff0d2dde297e467b71f64f8cd27ef1d8103e16297c8eca497e89',particles:151505,constraints:151179,configured:'84289385417b4d826a7c541d0b5af9aaac4cb6de8550181b91d01bc3eb7e37e8',force_index:3,force_types:['HarmonicBondForce','HarmonicAngleForce','PeriodicTorsionForce','NonbondedForce']}
});
const BOX=freeze([[11.306514700000001,0,0],[0,11.1129538,0],[0,0,12.4094174]]);
const PUBLIC_BASE='https://raw.githubusercontent.com/ORVIArh/ORVIA/research/mainnet-readiness/evidence/phosphate-v0.3/';
export const NATIVE_PUBLIC_EVIDENCE=freeze({
  inputs:{url:PUBLIC_BASE+'phosphate-v0.3-inputs.tar.gz',bytes:6996476,sha256:'68b8eb37010bb108e05aefff9d19d9fac5bf39fa3946ecb82edd731ce4507fc0'},
  accuracy:{url:PUBLIC_BASE+'native-double-pme/accuracy-evidence.zip',bytes:8263914,sha256:'6db8c1556c7ef2684dedf7a95cadd12951827da0eb30c31245d4f3068a035619'},
  engine:{url:PUBLIC_BASE+'native-double-pme/engine-runtime-with-licenses.zip',bytes:18266689,sha256:'88aa8f1997ea520027f6403822c5a2973363d15447b8f75e8d01b50bce641e50'}
});

function read(file,max=32*1024*1024){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const before=fs.fstatSync(fd);must(before.isFile()&&before.size>0&&before.size<=max,'Invalid or oversized artifact');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
    must(bytes.length===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'Artifact changed during read');return bytes;
  }finally{fs.closeSync(fd);}
}
function metric(m,atoms){
  must(m&&['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2','reference_force_L2','force_difference_L2'].every(k=>finite(m[k])&&m[k]>=0)&&finite(m.reference_energy_kJ_mol)&&finite(m.target_energy_kJ_mol),'Missing or invalid comparison metric');
  const e=Math.abs(m.reference_energy_kJ_mol-m.target_energy_kJ_mol),r=m.force_difference_L2/Math.max(m.reference_force_L2,1e-12);
  must(finite(e)&&finite(r)&&near(e,m.energy_absolute_kJ_mol)&&near(r,m.force_relative_L2)&&m.force_difference_L2+1e-12>=m.force_max_absolute_kJ_mol_nm&&m.force_difference_L2<=Math.sqrt(3*atoms)*m.force_max_absolute_kJ_mol_nm+1e-12,'Comparison arithmetic or norm bounds disagree');
  const passed=e<=LIMITS.energy_absolute_kJ_mol&&m.force_max_absolute_kJ_mol_nm<=LIMITS.force_max_absolute_kJ_mol_nm&&r<=LIMITS.force_relative_L2;
  must(m.passed===passed,'Comparison success flag contradicts fixed tolerance');return passed;
}
function observation(o){must(o&&finite(o.energy_kJ_mol)&&finite(o.force_L2)&&o.force_L2>=0&&finite(o.max_abs_force_kJ_mol_nm)&&o.max_abs_force_kJ_mol_nm>=0&&o.max_abs_force_kJ_mol_nm<POLICY.force_margin_kJ_mol_nm,'Invalid or unsafe force observation');}

export function assessNativeFullModelDiagnostic({reportFile}){
  const wrapperBytes=read(reportFile,1024*1024),wrapper=JSON.parse(wrapperBytes);canonical(wrapper);
  must(wrapper.schema==='orvia.native-full-model-admission-packet.v1'&&wrapper.diagnosticOnly===true&&wrapper.scientificAcceptance===false&&wrapper.retrospective===true,'Unsupported diagnostic packet or claim');
  must(same(wrapper.publicEvidence,NATIVE_PUBLIC_EVIDENCE),'Public evidence identity changed');
  const expected=['environment/engine-build-report.json',...Object.keys(SOURCES).map(n=>'sources/'+n),...Object.keys(INPUTS).flatMap(leg=>['reports/'+leg+'.json','checkpoints/'+leg+'.chk','positions/'+leg+'.json'])].sort();
  must(same(Object.keys(wrapper.files||{}).sort(),expected),'Missing or extra packet artifacts');
  const root=path.dirname(path.resolve(reportFile)),payload={};
  for(const name of expected){
    const descriptor=wrapper.files[name];must(descriptor&&same(Object.keys(descriptor).sort(),['bytes','sha256'])&&Number.isSafeInteger(descriptor.bytes)&&descriptor.bytes>0&&SHA.test(descriptor.sha256),'Invalid artifact descriptor');
    const parent=path.join(root,path.dirname(name));must(fs.lstatSync(parent).isDirectory()&&!fs.lstatSync(parent).isSymbolicLink(),'Artifact directory must not be a symlink');
    const bytes=read(path.join(root,name));must(bytes.length===descriptor.bytes&&sha(bytes)===descriptor.sha256,'Artifact hash or length mismatch: '+name);payload[name]=bytes;
  }
  for(const [name,digest] of Object.entries(SOURCES))must(wrapper.files['sources/'+name].sha256===digest,'Unreviewed worker source');
  must(wrapper.files['environment/engine-build-report.json'].sha256===BUILD,'Unreviewed engine build');
  const build=JSON.parse(payload['environment/engine-build-report.json']);
  must(build.buildPassed===true&&build.scientificAcceptance===false&&build.upstreamCommit==='b399af4725573963b46d6c1083fdcf7a37615857','Engine identity mismatch');
  let passed=true;const environments=[],metrics=[];
  for(const [leg,input] of Object.entries(INPUTS)){
    const r=JSON.parse(payload['reports/'+leg+'.json']);canonical(r);
    must(r.schema==='orvia.matched-grid-native-double-coordinate-diagnostic.v1'&&r.production_ready===false&&r.scientific_acceptance===false&&r.input_files_modified===false&&r.reference_test_mode===false&&r.requested_platform==='CUDA'&&r.requested_precision==='double'&&r.requested_precheck_platform==='Reference','Unsupported native report or claim');
    must(r.script_sha256===SOURCES['model_repair_gpu_matched.py']&&r.base_worker_sha256===SOURCES['model_repair_gpu.py']&&same(r.predeclared,POLICY)&&r.openmm_version==='8.6.1.dev-b399af4'&&r.numpy_version==='2.5.4','Unreviewed source, environment or numerical policy');
    must(same(r.inputs,{system_sha256:input.system_sha256,positions_sha256:input.positions_sha256,particles:input.particles,constraints:input.constraints,force_types:input.force_types,box_vectors_nm:BOX,periodic:true}),'Native model/input identity changed');
    const alignment=r.numerical_alignment;
    must(alignment?.source_system_sha256===input.system_sha256&&alignment.configured_system_sha256===input.configured&&alignment.force_index===input.force_index&&same(alignment.alpha_inv_nm_and_grid,GRID),'PME alignment changed');
    const engine=r.engine;must(engine?.build_report_sha256===BUILD&&engine.experimental_native_double_pme_patch===true&&engine.upstream_commit===build.upstreamCommit&&same(engine.artifacts,build.artifacts),'Loaded engine identity differs');
    must(Array.isArray(engine.loaded_native_libraries)&&engine.loaded_native_libraries.length===Object.keys(build.artifacts).length,'Loaded native libraries missing');
    const loaded=new Set();for(const item of engine.loaded_native_libraries){const rel=item.path?.replace(/^\/workspace\/orvia-native-double-build-r2\//,'');must(build.artifacts[rel]?.sha256===item.sha256&&!loaded.has(rel),'Loaded library differs');loaded.add(rel);}
    must(r.contexts?.independent?.actual_platform==='Reference'&&same(r.contexts.independent.actual_properties,{})&&same(r.contexts.independent.actual_pme_alpha_and_grid,GRID),'Independent Reference oracle missing');
    for(const key of ['grid_selection','native_target','restrained_target']){const c=r.contexts[key];must(c?.actual_platform==='CUDA'&&c.actual_properties?.Precision==='double'&&c.actual_properties.DeviceName==='NVIDIA H200'&&c.actual_properties.UseCpuPme==='false'&&(key==='grid_selection'||same(c.actual_pme_alpha_and_grid,GRID)),'Actual CUDA double execution metadata missing');}
    must(r.hardware_execution_verified===true&&r.actual_platform==='CUDA'&&same(r.actual_properties,r.contexts.native_target.actual_properties),'Hardware flag contradicts execution metadata');
    environments.push({leg,openmm:r.openmm_version,numpy:r.numpy_version,engine:r.engine,contexts:r.contexts});
    let legPassed=true;
    for(const phase of ['initial','final','post_nve']){const m=r[phase+'_comparison'];legPassed=metric(m,input.particles)&&legPassed;metrics.push({leg,phase,...m});if(phase!=='post_nve'){for(const side of ['independent','target'])observation(r[phase+'_'+side]);must(m.reference_energy_kJ_mol===r[phase+'_independent'].energy_kJ_mol&&m.target_energy_kJ_mol===r[phase+'_target'].energy_kJ_mol&&m.reference_force_L2===r[phase+'_independent'].force_L2,'Comparison and observation disagree');}}
    must(Array.isArray(r.stages)&&r.stages.length===3,'Incomplete relaxation evidence');
    r.stages.forEach((s,i)=>{must(s.stage===i&&s.restraint_k===POLICY.restraint_k_kJ_mol_nm2_and_max_iterations[i][0]&&s.max_iterations===POLICY.restraint_k_kJ_mol_nm2_and_max_iterations[i][1]&&SHA.test(s.positions_sha256)&&finite(s.elapsed_seconds)&&s.elapsed_seconds>=0,'Changed restraint schedule');observation(s.restrained_state);});
    must(Array.isArray(r.nve_diagnostic)&&r.nve_diagnostic.length===10,'Incomplete diagnostic trajectory');r.nve_diagnostic.forEach((s,i)=>{must(s.step===i+1,'Diagnostic trajectory order differs');observation(s);});
    must(r.post_nve_comparison.target_energy_kJ_mol===r.nve_diagnostic[9].energy_kJ_mol,'Post-NVE comparison is not the final observed frame');
    must(r.passed===legPassed&&r.status===(legPassed?'passed_diagnostic_only':'failed')&&(legPassed?!Object.hasOwn(r,'error'):typeof r.error?.message==='string'),'Native aggregate contradicts numerical evidence');
    // Coordinates and opaque OpenMM checkpoint are separately content-bound; the
    // association is exporter/operator evidence, not a proof of checkpoint state.
    const positions=JSON.parse(payload['positions/'+leg+'.json']);
    must(Array.isArray(positions.positions_nm)&&positions.positions_nm.length===input.particles&&positions.positions_nm.every(v=>Array.isArray(v)&&v.length===3&&v.every(finite))&&same(positions.box_vectors_nm,BOX),'Final coordinate payload is incomplete');
    passed&&=legPassed;
  }
  const protocol={schema:'orvia.native-full-model-diagnostic-protocol.v1',inputs:INPUTS,sources:SOURCES,engineBuildSha256:BUILD,policy:POLICY,pme:GRID,diagnosticOnly:true,retrospective:true,scope:'native B full models; no alchemical endpoint or affinity acceptance',reportedCounter:'completed native full-model comparison cases'};
  const checkpointManifest=Object.fromEntries(expected.filter(n=>n.startsWith('checkpoints/')||n.startsWith('positions/')).map(n=>[n,wrapper.files[n]]));
  const artifactManifest={schema:'orvia.native-full-model-result-manifest.v1',packet:{bytes:wrapperBytes.length,sha256:sha(wrapperBytes)},files:wrapper.files,publicEvidence:wrapper.publicEvidence};
  const configuration={protocolHash:hash(protocol),modelHash:hash(INPUTS),inputHash:hash({inputs:INPUTS,archive:NATIVE_PUBLIC_EVIDENCE.inputs}),softwareHash:hash({sources:SOURCES,engineBuild:BUILD}),environmentHash:hash(environments),requiredChecks:7,allowedChecks:7,diagnosticOnly:true};
  const result={schema:'orvia.native-full-model-worker-admission.v1',admissible:true,experimentId:NATIVE_FULL_MODEL_EXPERIMENT_ID,configuration,diagnosticOnly:true,scientificAcceptance:false,retrospective:true,checks:passed?7:3,outcome:passed?1:2,completedSteps:'6',counterUnit:protocol.reportedCounter,checkpointHash:hash(checkpointManifest),resultHash:hash(artifactManifest),runConfigHash:hash(protocol),artifactManifest,metrics,trust:'Retrospective operator attestation of diagnostic artifacts; hashes, signatures and consistency checks do not prove GPU computation or scientific validity'};
  freeze(result);branded.add(result);return result;
}
export function assertNativeFullModelAssessment(a){must(branded.has(a)&&a.experimentId===NATIVE_FULL_MODEL_EXPERIMENT_ID&&a.admissible===true&&a.diagnosticOnly===true,'Fresh reviewed native full-model assessment required');return a;}
