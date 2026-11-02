// Admission for a specific reviewed endpoint diagnostic, not the full phosphate model.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {id} from 'ethers';
import {canonical} from './admission.mjs';

export const PRECISION_EXPERIMENT_ID=id('ORVIA.ENDPOINT_BINARY64_PARAMETER_DIAGNOSTIC.v1');
const sourceHashes=Object.freeze({
  'precision_diagnostics.py':'ccf69af6a5aa874a79f6401406d8681fb213dbe2e1b7f25af466fe3d05547544',
  'precision_system.py':'b68364cdf758bba0af27c6eda460592acee1445851efb403d0a7915e9dac0fba',
  'validate_endpoints.py':'676fb66566620c1ac6fb1819526cb4454fd98174978e3a60a8b44029b02b004c'
});
const inputs=Object.freeze({
  A:{'system.xml':'c36171b19a956c67770f62f9904039a6eed7e24a33c0369b42927a221862682c','parameters.json':'3b895fe11c6192144e89a89488e91c8939d7b140308756f9371e6913f36208c7'},
  B:{'system.xml':'abf9a367fa606f16b7301b572bac0fb0d5582cb6e2742c4000e78b32c4908a97','parameters.json':'5e97e15c92dcfa844e517766a6857a89256ce46db98dc1ba847b5d243b345c1a'}
});
const repairedHashes={A:'9c748453b33112c1668fdb5df97a8b84846a34d4b59656ad28580e4acc40f333',B:'0542fe1a997b3d0ed9f1bc28c31b4f57d3c0af5dfab8830f9debe5eca012517b'};
const limits=Object.freeze({energy_absolute_kJ_mol:0.01,force_max_absolute_kJ_mol_nm:0.05,force_relative_L2:5e-5,trajectory_position_RMS_nm:1e-5});
const must=(ok,message)=>{if(!ok)throw new Error(message);};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>'0x'+sha(canonical(x));
const near=(a,b)=>Math.abs(a-b)<=1e-12+1e-7*Math.max(Math.abs(a),Math.abs(b));
const admitted=new WeakSet();
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

function checkedMetric(metric,atoms,trajectory=false) {
  must(metric&&['energy_absolute_kJ_mol','force_max_absolute_kJ_mol_nm','force_relative_L2','reference_force_L2','force_difference_L2']
    .every(k=>finite(metric[k])&&metric[k]>=0)&&finite(metric.reference_energy_kJ_mol)&&finite(metric.target_energy_kJ_mol),
    'Missing or invalid numerical evidence');
  const energyError=Math.abs(metric.reference_energy_kJ_mol-metric.target_energy_kJ_mol);
  const relativeError=metric.force_difference_L2/Math.max(metric.reference_force_L2,1e-12);
  must(finite(energyError)&&finite(relativeError)
    &&near(metric.energy_absolute_kJ_mol,energyError)
    &&near(metric.force_relative_L2,relativeError)
    &&metric.force_difference_L2+1e-12>=metric.force_max_absolute_kJ_mol_nm
    &&metric.force_difference_L2<=Math.sqrt(3*atoms)*metric.force_max_absolute_kJ_mol_nm+1e-12,
    'Reported error disagrees with its underlying norms or energies');
  let passed=energyError<=limits.energy_absolute_kJ_mol
    &&metric.force_max_absolute_kJ_mol_nm<=limits.force_max_absolute_kJ_mol_nm
    &&relativeError<=limits.force_relative_L2;
  if(trajectory){
    must(finite(metric.position_RMS_difference_nm)&&metric.position_RMS_difference_nm>=0,'Position comparison missing');
    passed=passed&&metric.position_RMS_difference_nm<=limits.trajectory_position_RMS_nm;
  }
  must(typeof metric.passed==='boolean'&&metric.passed===passed,'Numerical success flag contradicts original tolerances');
  return passed;
}

export function assessPrecisionDiagnostic({reportFile}) {
  const fd=fs.openSync(reportFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat=fs.fstatSync(fd);
    must(stat.isFile()&&stat.size>0&&stat.size<=4*1024*1024,'Invalid precision report file');
    bytes=Buffer.alloc(stat.size+1); const n=fs.readSync(fd,bytes,0,bytes.length,0);
    must(n===stat.size,'Precision report changed during read'); bytes=bytes.subarray(0,n);
    const after=fs.fstatSync(fd);must(after.size===stat.size&&after.mtimeMs===stat.mtimeMs,'Precision report changed during read');
  } finally {fs.closeSync(fd);}
  const report=JSON.parse(bytes);canonical(report);
  must(report.schema==='orvia.endpoint-precision-repair.v1'&&report.requested_platform==='CUDA'&&report.requested_precision==='double'
    &&report.repaired_hamiltonian_parameter_change===false&&report.tolerance_change===false
    &&report.production_ready===false&&report.scientific_acceptance===false&&report.perturbation_seed===9917,
    'Unsupported precision diagnostic or claim');
  must(canonical(report.source_sha256)===canonical(sourceHashes)&&canonical(report.tolerances_predeclared)===canonical(limits)
    &&report.openmm_version==='8.6.1.dev-b399af4'&&report.numpy_version==='2.5.4'
    &&canonical(report.minimization)===canonical({force_tolerance_kJ_mol_nm:1,maximum_iterations:1000,convergence_claim:false}),
    'Unreviewed diagnostic source, environment or numerical policy');
  must(Array.isArray(report.endpoints)&&report.endpoints.length===2,'Both endpoint records are required');
  let passed=true,hardware=true,count=0;const environments=[];
  for(const [i,name] of ['A','B'].entries()) {
    const endpoint=report.endpoints[i];
    must(endpoint.endpoint===name&&endpoint.atoms===(name==='A'?41:44)
      &&canonical(endpoint.input_sha256)===canonical(inputs[name])&&endpoint.repaired_system_sha256===repairedHashes[name],
      'Endpoint identity changed');
    const platforms=endpoint.platforms;
    must(platforms?.reference?.name==='Reference','Native Reference oracle is missing');
    const gpu=platforms?.repaired;
    const hardwarePassed=gpu?.name==='CUDA'&&gpu.properties?.Precision==='double'
      &&typeof gpu.properties.DeviceName==='string'&&gpu.properties.DeviceName.startsWith('NVIDIA ');
    must(endpoint.hardware_execution_verified===hardwarePassed,'Hardware verification flag contradicts actual platform');
    hardware&&=hardwarePassed;environments.push(gpu);
    must(Array.isArray(endpoint.scenarios)&&endpoint.scenarios.length===9,'Nine static scenarios required');
    let endpointPassed=true;
    for(const [j,scenario] of endpoint.scenarios.entries()) {
      must(scenario.scenario===(j===0?'original':'perturbation_'+j),'Unexpected scenario order');
      endpointPassed=checkedMetric(scenario.repaired,endpoint.atoms)&&endpointPassed;count++;
    }
    const trajectory=endpoint.deterministic_short_trajectory;
    must(trajectory?.steps===20&&trajectory.dt_ps===0.0002&&trajectory.initial_velocities==='zero','Trajectory schedule changed');
    const trajectoryMetric=trajectory.repaired;
    must(finite(trajectoryMetric?.position_RMS_difference_nm)&&trajectoryMetric.position_RMS_difference_nm>=0,'Position comparison missing');
    endpointPassed=checkedMetric(trajectoryMetric,endpoint.atoms,true)&&endpointPassed;count++;
    must(canonical(Object.keys(endpoint.minimized_fixtures||{}).sort())===canonical(['native','repaired','rounding_surrogate']),
      'Three minimized-coordinate fixtures required');
    for(const fixture of Object.values(endpoint.minimized_fixtures)) {
      must(Array.isArray(fixture.positions_nm)&&fixture.positions_nm.length===endpoint.atoms
        &&fixture.positions_nm.every(v=>Array.isArray(v)&&v.length===3&&v.every(finite)),'Minimized coordinates missing');
      endpointPassed=checkedMetric(fixture.comparisons?.repaired,endpoint.atoms)&&endpointPassed;count++;
    }
    must(endpoint.passed===endpointPassed&&endpoint.status===(endpointPassed?'passed_repaired_path':'failed_strict_tolerance')
      &&!Object.hasOwn(endpoint,'error'),'Endpoint aggregate contradicts numerical evidence');passed&&=endpointPassed;
  }
  const strict=passed&&hardware;
  must(report.passed===strict&&report.strict_cuda_acceptance===strict&&report.hardware_execution_verified===hardware,
    'Aggregate precision flags contradict evidence');
  must(report.status===(strict?'passed_cuda_endpoint_repair':'failed')&&!Object.hasOwn(report,'error'),
    'Aggregate precision status contradicts evidence');
  const protocol={schema:'orvia.endpoint-precision-diagnostic-protocol.v1',inputs,sourceHashes,repairedHashes,limits,
    staticScenariosPerEndpoint:9,trajectoryStepsPerEndpoint:20,trajectoryDtPs:0.0002,minimizedFixturesPerEndpoint:3,
    diagnosticOnly:true,fullPeriodicModelValidation:false,reportedCounter:'completed endpoint comparison cases'};
  const configuration={protocolHash:hash(protocol),modelHash:hash(repairedHashes),inputHash:hash(inputs),softwareHash:hash(sourceHashes),
    environmentHash:hash({openmm:report.openmm_version,numpy:report.numpy_version,platforms:environments}),
    requiredChecks:7,allowedChecks:7,diagnosticOnly:true};
  const artifactManifest={schema:'orvia.retrieved-precision-artifact.v1',files:{'precision-diagnostics.json':{bytes:bytes.length,sha256:sha(bytes)}}};
  const checks=1|(hardware?2:0)|(passed?4:0);
  const assessment={schema:'orvia.precision-worker-admission.v1',admissible:true,experimentId:PRECISION_EXPERIMENT_ID,configuration,
    diagnosticOnly:true,scientificAcceptance:false,fullPeriodicModelValidation:false,checks,outcome:strict?1:2,
    completedSteps:String(count),counterUnit:protocol.reportedCounter,checkpointHash:hash(inputs),
    resultHash:hash(artifactManifest),runConfigHash:hash(protocol),artifactManifest,
    trust:'Operator-attested diagnostic artifacts; signatures and consistency checks do not prove correct GPU computation'};
  freeze(assessment);admitted.add(assessment);return assessment;
}

/** Reject parsed JSON or modified substitutes at the report-signing boundary. */
export function assertPrecisionAssessment(assessment){
  must(admitted.has(assessment)&&assessment.experimentId===PRECISION_EXPERIMENT_ID
    &&assessment.admissible===true&&assessment.diagnosticOnly===true,'Fresh reviewed precision assessment required');
  return assessment;
}
