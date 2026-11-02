#!/usr/bin/env python3
"""Read-only measurements -> bounded-scope, source-bound candidate review."""
from pathlib import Path
from fractions import Fraction
import json,hashlib,math,datetime
BASE=Path(__file__).resolve().parent
ROOT=BASE.parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(name):return json.loads((BASE/name).read_text())
def rational(x):
 x=Fraction(x)
 return {'numerator':str(x.numerator),'denominator':str(x.denominator),'decimal':format(x.numerator/x.denominator,'.17g')}
def sumgas(run,stage=None):return sum(int(x['gas'])for x in run['receipts']if stage is None or x['stage']==stage)
def fit(receipts,pairs,particles):
 rows=[]
 for receipt in receipts:
  if receipt['stage']!=6:continue
  start=int(receipt['cursor']); end=min(start+receipt['work'],len(pairs)); sub=pairs[start:end]
  n=sum(particles[a][2]>0 and particles[b][2]>0 for a,b in sub);z=len(sub)-n
  rows.append((z,n,int(receipt['gas'])))
 a=sum(z*z for z,n,g in rows);b=sum(z*n for z,n,g in rows);c=sum(n*n for z,n,g in rows)
 v=sum(z*g for z,n,g in rows);w=sum(n*g for z,n,g in rows);det=a*c-b*b
 assert det>0
 beta=[Fraction(v*c-w*b,det),Fraction(w*a-v*b,det)]
 residual=[Fraction(g)-z*beta[0]-n*beta[1]for z,n,g in rows]
 return {'rows':len(rows),'columns':['zeroLJCount','nonzeroLJCount'],'intercept':False,'rank':2,
  'effectiveZeroLJGasPerPair':rational(beta[0]),'effectiveNonzeroLJGasPerPair':rational(beta[1]),
  'maxAbsoluteReceiptResidualGas':rational(max(map(abs,residual))),
  'rootMeanSquaredReceiptResidualGas':math.sqrt(sum(float(x*x)for x in residual)/len(residual)),
  'residualIsNotFullModelUncertainty':True,
  'interpretation':'Small native16 fixture effective receipt fit with fixed work, including advance/dependency checks, pair indexing and local snapshot/catalog access. It is not a universal marginal pair cost.'}, beta
primary=load('benchmark-report.json');mixed=load('mixed-benchmark-report.json');prep=load('candidate-preparation.json')
assert primary['status']=='passed' and primary['passed'] and mixed['status']=='passed' and mixed['passed'],'Do not issue passing review from incomplete or failed reports'
assert not primary['failures'] and not mixed['failures']
assert primary['compiler']==mixed['compiler']=='0.8.26+commit.8a97fa7a.Emscripten.clang'
for k in ('baselineInputSha256','candidateInputSha256'):assert primary['compilation'][k]==mixed['compilation'][k]
assert sha(BASE/'AlchemicalHamiltonianEvaluator.baseline.sol')==prep['baseline_source_sha256']
assert sha(BASE/'AlchemicalHamiltonianEvaluator.candidate.sol')==prep['candidate_source_sha256']
assert sha(BASE/'cases/cases.json')==primary['caseInputSha256']
assert sha(BASE/'cases/mixed-cases.json')==mixed['caseInputSha256']
assert sha(BASE/'benchmark.mjs')==sha(BASE/'benchmark-primary-run.mjs')
assert sha(BASE/'mixed-benchmark.mjs')==mixed['runnerSha256']
sources=load('baseline-sources.json')
for name,h in prep['baseline_sources'].items():assert hashlib.sha256(sources[name]['content'].encode()).hexdigest()==h,name
native=json.loads((ROOT/'output/gas-estimate/outside-pair-input.json').read_text());assert sha(ROOT/'output/gas-estimate/outside-pair-input.json')==prep['native_pair_input_sha256']
pairs=[(a,b)for a in range(len(native['particles']))for b in range(a+1,len(native['particles']))]
bywork={n['work']:n['runs'][0]for n in primary['native']};assert set(bywork)=={1,8}
for k in ('baseline','candidate'):assert bywork[1][k]['words']==bywork[8][k]['words'],k+' work1/work8 numerical parity'
rows=[];fit_coeff={}
for work,r in sorted(bywork.items()):
 entry={'work':work,'unorderedPairs':len(pairs),'exactCompleteOutputsIdentical':r['passed'],'advanceReceiptsOnly':True,'registrationSetupDeploymentExcluded':True}
 for k in ('baseline','candidate'):
  entry[k]={'pairStageGas':sumgas(r[k],6),'allAdvanceGas':sumgas(r[k]),'prePairGas':sum(int(v['gas'])for v in r[k]['receipts']if v['stage']<6)}
  entry[k]['outsideReceiptClassFit'],fit_coeff[work,k]=fit(r[k]['receipts'],pairs,native['particles'])
 entry['pairStageReductionPercent']=100*(1-entry['candidate']['pairStageGas']/entry['baseline']['pairStageGas'])
 entry['allAdvanceReductionPercent']=100*(1-entry['candidate']['allAdvanceGas']/entry['baseline']['allAdvanceGas'])
 entry['atomPrepassExtraGas']=entry['candidate']['prePairGas']-entry['baseline']['prePairGas']
 rows.append(entry)
reports=[primary,mixed];profiles=[p for report in reports for p in report['native']+report['cases']];runs=[r for p in profiles for r in p['runs']]
old_path=ROOT/'output/gas-estimate/gas-report.json';old=json.loads(old_path.read_text());projections={}
for name,model in old['models'].items():
 scenario=next(x for x in model['cutoffScenarios']if x['cutoffNm']==1.0);counts=scenario['nativeNormalPairBinsAfterExceptionRemoval']
 z=counts['outside_cutoff_zero_lj'];n=counts['outside_cutoff_nonzero_lj'];result={}
 for k in ('baseline','candidate'):
  b=fit_coeff[8,k];value=z*b[0]+n*b[1]
  result[k]={'nativeOutsideOnlyProjectedGas':rational(value),'roundedUp':str(math.ceil(value))}
 projections[name]={'nativeAtoms':model['nativePhysicalAtoms'],'unacceptedHybridCandidateAtoms':model['hybridCandidateAtoms'],
  'outsideZeroLJPairs':z,'outsideNonzeroLJPairs':n,'cutoffNm':1.0,**result}
report={'schema':'orvia.guarded-cutoff-independent-review.v1','status':'passed_component_comparison','passed':True,
 'createdAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baselineHamiltonianSha256':prep['baseline_source_sha256'],'candidateHamiltonianSha256':prep['candidate_source_sha256'],
 'compilation':primary['compilation'],'compiler':primary['compiler'],'canonicalCurrentHamiltonianSha256':sha(ROOT/'ORVIA/contracts/core/AlchemicalHamiltonianEvaluator.sol'),
 'profiles':len(profiles),'evaluationsPerImplementation':len(runs),'completeEvaluationsPerImplementation':sum(r['baseline']['complete']for r in runs),
 'matchingRejectedEvaluationsPerImplementation':sum(not r['baseline']['complete']for r in runs),'rawOutputWordsCompared':sum(r['exactWordsCompared']for r in runs),
 'nativeWork1Work8AllNumericalOutputsIdentical':True,'nativeGasMeasurements':rows,'nativeOutsidePartialSensitivity':projections,
 'profileAdvanceGas':[{'name':p['name'],'work':p['work'],'states':[{'state':r['state'],'complete':r['baseline']['complete'],'baselineAdvanceGas':sumgas(r['baseline']),'candidateAdvanceGas':sumgas(r['candidate']),'candidateExtraAdvanceGas':sumgas(r['candidate'])-sumgas(r['baseline'])}for r in p['runs']]}for p in profiles],
 'scientificAcceptance':False,'mainnetTransactionsSent':0,'fullProteinForcePassMeasured':False,'fullCampaignQuoted':False,'targetFeeQuoted':False,
 'candidateAdmission':'Component comparison passed; parent owns integration and final whole-engine verification. No scientific acceptance or full-model claim.',
 'guard':{'bound':'Finite consumed positions, box lengths, interpolated q, both endpoint sigma and epsilon: abs<=2^256. Any unsafe disables shortcut for entire evaluation.',
  'rationale':['Same geometry call precedes shortcut as baseline. With finite bounded displacement, ordered norm and sqrt cannot newly overflow. Underflow norm zero stays below positive cutoff and falls through original path.',
   'With sigma/epsilon/q bounds, skipped sigma sums, epsilon products and charge products are finite. Topology already validates positive cutoff/alpha and alpha*cutoff<=16. Only legacy zero-return outside branches are omitted.',
   'Inside-cutoff path, complete pair order, direct/excluded exceptions and all Ewald reciprocal/self/background stages remain unchanged. No Fixed96 substitution.',
   'Atom prepass adds four nonbonded reads per eligible atom, using positions/q already read; no extra per-pair storage. Run ABI adds packed eligibility bool; consumers need recompilation.']},
 'limitations':['Finite-case exact regression comparisons support the guarded equivalence argument; they are not a machine-checked universal theorem.',
  'Gas is actual local Shanghai EVM receipt gas, unlimited contract-size mode, baseline/candidate identical transaction boundaries and shared modules. Target-client tariffs/throughput/fee allocation not measured.',
  'All-advance totals exclude registerEvaluation, topology/input/state setup and deployment. They include complete finite-mode Ewald evaluation for completed small fixtures. Failed-case totals exclude the reverted receipt and are not a full cost of rejection.',
  'Eligible inside pairs duplicate the norm and incur overhead; the atom prepass also costs gas. Candidate is not a universal speedup. Per-profile deltas are retained.',
  'Native outside-only sensitivity reuses source-hashed GPU/exclusion census. It excludes inside pairs, all exceptions, reciprocal, bonded/improper, C4, constraints, initial eligibility prepass, snapshots/state/upload and L1 allocation. It is not whole-force/step/campaign gas or a lower-bound theorem.',
  'Small16atom fit cannot bound full-index arithmetic, bank/shard access/locality, parameter distributions or interleaving. Fit residual is only fixture fit error.',
  'Equivalence assumes authenticated sealed immutable input pages. Hypothetical evm_setAccountCode replacement after the eligibility prepass may be detected at a different point or skipped for outside pairs; this suite does not assert equivalence under arbitrary mid-run page replacement. Catalog assertTopology does not globally rescan all page code hashes.',
  'Full-model inputs/quantum/model/physical gates remain unaccepted; no optimizer was restarted. Different bigcomplex box has no matched solvent candidate.'],
 'sourceFiles':[]}
for p in [BASE/'candidate-preparation.json',BASE/'baseline-sources.json',BASE/'AlchemicalHamiltonianEvaluator.baseline.sol',BASE/'AlchemicalHamiltonianEvaluator.candidate.sol',BASE/'CutoffSnapshotWriter.sol',BASE/'benchmark.mjs',BASE/'benchmark-primary-run.mjs',BASE/'mixed-benchmark.mjs',BASE/'benchmark-report.json',BASE/'mixed-benchmark-report.json',BASE/'cases/cases.json',BASE/'cases/mixed-cases.json',BASE/'cases/mixed-classification.json',Path(__file__).resolve(),old_path,ROOT/'output/gas-estimate/outside-pair-input.json']:
 report['sourceFiles'].append({'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size})
(BASE/'review-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k]for k in ('status','profiles','evaluationsPerImplementation','completeEvaluationsPerImplementation','matchingRejectedEvaluationsPerImplementation','rawOutputWordsCompared')},indent=2))
print('reviewSummarySha256',sha(BASE/'review-summary.json'))
