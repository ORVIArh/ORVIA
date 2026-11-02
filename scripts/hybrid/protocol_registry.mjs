import path from 'node:path';
import {assessPhosphateBenchmark,assertPhosphateAssessment} from './admission.mjs';
import {assessPrecisionDiagnostic,assertPrecisionAssessment} from './precision_admission.mjs';
import {assessNativeFullModelDiagnostic,assertNativeFullModelAssessment} from './native_full_model_admission.mjs';
import {normalizeReport} from './attestation.mjs';

export const PROTOCOL_IDS=Object.freeze(['phosphate-native-force-v1','endpoint-precision-v1','native-full-model-diagnostic-v1']);
export function normalizeArtifactSpec(spec){
  if(!spec||typeof spec!=='object'||Array.isArray(spec))throw new Error('Artifact specification required');
  const fields=spec.protocol==='phosphate-native-force-v1'?['protocol','bundleRoot','resultsRoot']
    :['endpoint-precision-v1','native-full-model-diagnostic-v1'].includes(spec.protocol)?['protocol','reportFile']:null;
  if(!fields||Object.keys(spec).sort().join(',')!==fields.sort().join(','))throw new Error('Unknown protocol or artifact specification fields');
  const result={protocol:spec.protocol};for(const key of fields.filter(x=>x!=='protocol')){if(typeof spec[key]!=='string'||!spec[key])throw new Error('Artifact path required');result[key]=path.resolve(spec[key]);}return result;
}
export function assessProtocol(spec){
  const input=normalizeArtifactSpec(spec);
  return input.protocol==='phosphate-native-force-v1'?assessPhosphateBenchmark(input):input.protocol==='endpoint-precision-v1'?assessPrecisionDiagnostic(input):assessNativeFullModelDiagnostic(input);
}
export function assertReviewedAssessment(assessment){
  try{return assertPhosphateAssessment(assessment);}catch{}
  try{return assertPrecisionAssessment(assessment);}catch{}
  return assertNativeFullModelAssessment(assessment);
}
export function buildUnsignedReport(assessment,{runId,configurationHash,sequence,previousCheckpointHash,validUntil}){
  assertReviewedAssessment(assessment);
  return normalizeReport({runId,configurationHash,sequence,completedSteps:assessment.completedSteps,previousCheckpointHash,
    checkpointHash:assessment.checkpointHash,resultHash:assessment.resultHash,outcome:assessment.outcome,checks:assessment.checks,validUntil});
}
