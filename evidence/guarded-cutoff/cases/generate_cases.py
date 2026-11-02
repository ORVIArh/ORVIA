"""Generate two-atom evaluator equivalence cases; writes only this directory."""
from pathlib import Path
import copy, hashlib, json, math, struct
OUT = Path(__file__).resolve().parent
SCIENCE = Path('/Users/abhijith/Documents/ChatGPT/AURA/work/scientific-preparation')
DATA = SCIENCE / 'data/prepared_candidate/ligand_endpoints_v0_1'

def q(value):
    value = float(value)
    assert math.isfinite(value)
    bits = struct.unpack('>Q', struct.pack('>d', value))[0]
    sign, exponent, mantissa = bits >> 63, (bits >> 52) & 2047, bits & ((1 << 52) - 1)
    if exponent == 0:
        assert mantissa == 0
        result = 0
    else:
        result = (sign << 127) | ((exponent - 1023 + 16383) << 112) | (mantissa << 60)
    return '0x' + result.to_bytes(16, 'big').hex()

def power(exponent, negative=False):
    assert -16382 <= exponent <= 16383
    return '0x' + (((int(negative) << 127) | ((exponent + 16383) << 112))).to_bytes(16, 'big').hex()

def adjacent(value, delta):
    return '0x' + (int(value, 16) + delta).to_bytes(16, 'big').hex()

def narrow(word):
    assert int(word, 16) >> 128 == 0
    return '0x' + int(word, 16).to_bytes(16, 'big').hex()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

Z, O = q(0), q(1)
LAMBDAS = [Z, q(.5), O]

def fixture(distance=1.5):
    ep = dict(particles=[[O, Z, Z, Z], [q(2), Z, Z, Z]],
              nonbonded=[[q(.5), q(.25), Z], [q(.5), q(.25), Z]],
              bonds=[], angles=[], torsions=[], exceptions=[])
    return dict(positions=[[Z, Z, Z], [q(distance), Z, Z]], a=copy.deepcopy(ep), b=copy.deepcopy(ep),
                box=[q(8)] * 3, switchDistance=q(2), cutoff=q(3), prefactor=O,
                alpha=q(.75), extent=1, softcoreAlpha=q(.5))

sources = {name: DATA / name for name in ['A/parameters.json', 'B/parameters.json', 'hybrid_model.json', 'hybrid_streams.json']}
source_records = {name: dict(path=str(path), bytes=path.stat().st_size, sha256=sha(path)) for name, path in sources.items()}
params = {ep: json.loads(sources[f'{ep}/parameters.json'].read_text()) for ep in ['A', 'B']}
model = json.loads(sources['hybrid_model.json'].read_text())
streams = json.loads(sources['hybrid_streams.json'].read_text())
cases = []

def add(name, source, description, outcomes=None, states=None, tags=None, provenance=None, eligible=None):
    case = dict(id=name, description=description, source=source, lambdas=LAMBDAS,
                statesToEvaluate=states if states is not None else [0],
                expectedOutcomes=outcomes or {'0': 'success'}, tags=tags or [],
                provenance=provenance or {'kind': 'synthetic exact binary128 engineering fixture'},
                expectedFastCutoffEligible=eligible,
                evidenceStatus='Generated input and reviewed expectation; parent harness must execute baseline/candidate equality. No result is claimed here.')
    cases.append(case)

for name, distance in [('below_switch', q(1.5)), ('switch_prev_binary128', adjacent(q(2), -1)),
                       ('switch_exact', q(2)), ('switch_next_binary128', adjacent(q(2), 1)),
                       ('cutoff_prev_binary128', adjacent(q(3), -1)), ('cutoff_exact', q(3)),
                       ('cutoff_next_binary128', adjacent(q(3), 1)), ('outside_cutoff', q(3.5))]:
    f = fixture(); f['positions'][1][0] = distance
    add(name, f, 'Only x displacement changes. Adjacent words are exact neighboring positive binary128 values, not binary64 perturbations.', tags=['boundary', 'ordinary-LJ'], eligible=True)
for name, distance in [('charged_only_inside', 1.5), ('charged_only_outside', 3.5)]:
    f = fixture(distance)
    for ep in ['a', 'b']:
        f[ep]['nonbonded'][0][1:] = [Z, q(.25)]
        f[ep]['nonbonded'][1][1:] = [Z, q(-.25)]
    add(name, f, 'Zero LJ epsilon with nonzero opposite atomic charges; reciprocal/self terms remain part of the full evaluation.', tags=['charge', 'zero-epsilon'], eligible=True)
for name, epsilon, charge, expected in [('inactive_overlap', 0, 0, 'success'), ('active_LJ_overlap', .25, 0, 'revert:ZeroSeparation'), ('active_charge_overlap', 0, .25, 'revert:ZeroSeparation')]:
    f = fixture(0)
    for ep in ['a', 'b']:
        for i in range(2): f[ep]['nonbonded'][i][1:] = [q(epsilon), q(charge if i == 0 else -charge)]
    add(name, f, 'Coincident ordinary pair. Inactive interactions must keep legacy success; active singularities must keep legacy failure.', outcomes={'0': expected}, tags=['overlap'], eligible=True)
f = fixture(0)
for row in f['b']['nonbonded']: row[0] = q(.625)
add('softcore_overlap_endpoint_and_interior', f, 'Changed LJ sigma selects softcore. Coincident intermediate state is softened; active endpoints remain singular.', outcomes={'0':'revert:SingularEndpoint','1':'success','2':'revert:SingularEndpoint'}, states=[0,1,2], tags=['softcore','overlap'], eligible=True)
for name, epsilon, charge, expected in [('underflow_norm_active_LJ', .25, 0, 'revert:ZeroSeparation'), ('underflow_norm_active_charge', 0, .25, 'revert:ZeroSeparation'), ('underflow_norm_inactive', 0, 0, 'success')]:
    f = fixture(); f['positions'][1][0] = power(-9000); f['switchDistance'] = power(-9001); f['cutoff'] = power(-8999)
    for ep in ['a','b']:
        for i in range(2): f[ep]['nonbonded'][i][1:] = [q(epsilon), q(charge if i == 0 else -charge)]
    add(name, f, 'r^2 and cutoff^2 underflow to zero. sqrt(r^2)=0 is below positive cutoff; a squared-cutoff shortcut would incorrectly erase active failure.', outcomes={'0':expected}, tags=['underflow','guard-semantic-trap'], eligible=True)
f=fixture(1)
for ep,e in [('a',-9000),('b',-9001)]:
    for row in f[ep]['nonbonded']: row[0]=power(e)
add('tiny_sigma_inside_changed_softcore', f, 'Positive tiny sigma has sigma^6 underflow in legacy softcore; inside-cutoff path must preserve that failure.', outcomes={'0':'revert:InvalidInput'}, tags=['underflow','inside-path'], eligible=True)

def native_projection(ep, indices, distance):
    p=params[ep]; f=fixture(distance)
    for target in ['a','b']:
        f[target]['particles']=[[q(p['masses_Da'][i]),Z,Z,Z] for i in indices]
        f[target]['nonbonded']=[[q(p['particles'][i][1]),q(p['particles'][i][2]),q(p['particles'][i][0])] for i in indices]
    f['prefactor']=q(p['nonbonded']['coulomb_prefactor'])
    return f
for ep,distance in [('A',1.5),('B',3.5)]:
    add(f'native_{ep}_parameter_projection', native_projection(ep,[0,3],distance), 'Native endpoint particle masses, sigma, epsilon, charges and Coulomb prefactor; coordinates/empty bonded graph are declared two-atom engineering projection.', provenance={'kind':'native parameter projection','source':f'{ep}/parameters.json','atom_indices_zero_based':[0,3]}, tags=['native','charge'], eligible=True)

def hybrid_projection(indices, distance):
    f=fixture(distance)
    for ep,target in [('A','a'),('B','b')]:
        f[target]['particles']=[[narrow(x) for x in streams[f'{ep}.particles'][i*4:i*4+4]] for i in indices]
        f[target]['nonbonded']=[[narrow(x) for x in streams[f'{ep}.nonbonded'][i*3:i*3+3]] for i in indices]
    f['prefactor']=q(model['endpoint_parameters']['A']['nonbonded']['coulomb_prefactor'])
    return f
for name,distance in [('hybrid_charges_inside',1.5),('hybrid_charges_outside',3.5)]:
    add(name, hybrid_projection([0,3],distance), 'Frozen hybrid streams supply exact encoded endpoint particle parameters. Check both endpoints and lambda=0.5.', outcomes={str(i):'success' for i in range(3)}, states=[0,1,2], provenance={'kind':'frozen hybrid stream projection','source':'hybrid_streams.json','hybrid_atom_indices_zero_based':[0,3]}, tags=['hybrid','charge'], eligible=True)
f=hybrid_projection([0,41],0)
assert int(f['a']['nonbonded'][1][1],16)==0 and int(f['a']['nonbonded'][1][2],16)==0
add('hybrid_ghost_overlap',f,'Hybrid atom41 is B-only: inactive at A, charged/LJ-active at B. At overlap lambda0 succeeds; intermediate charge is singular; lambda1 softcore active endpoint is singular.',outcomes={'0':'success','1':'revert:ZeroSeparation','2':'revert:SingularEndpoint'},states=[0,1,2],provenance={'kind':'frozen hybrid ghost projection','source':'hybrid_streams.json','hybrid_atom_indices_zero_based':[0,41]},tags=['hybrid','ghost','overlap'],eligible=True)

def with_native_exception(pair,distance):
    f=hybrid_projection(list(pair),distance)
    for ep,target in [('A','a'),('B','b')]:
        words=streams[f'{ep}.exceptions'];rows=[words[i:i+6] for i in range(0,len(words),6)];row=next(r for r in rows if [int(r[0],16),int(r[1],16)]==list(pair))
        f[target]['exceptions']=[[0,1,int(row[2],16),*[narrow(x) for x in row[3:]]]]
    return f
for name,pair,distance,expected in [('direct_exception_beyond_cutoff',(0,3),3.5,'success'),('excluded_exception_beyond_cutoff',(0,1),3.5,'success'),('direct_exception_overlap',(0,3),0,'revert:ZeroSeparation'),('excluded_exception_overlap',(0,1),0,'success'),('direct_exception_half_box_tie',(0,3),4,'revert:InvalidInput')]:
    f=with_native_exception(pair,distance)
    add(name,f,'Exact frozen hybrid exception parameters remapped onto two atoms. Direct/excluded exception path must remain untouched by ordinary-pair cutoff optimization.',outcomes={str(i):expected for i in range(3)},states=[0,1,2],provenance={'kind':'frozen hybrid exception projection','source':'hybrid_streams.json','hybrid_atom_indices_zero_based':list(pair)},tags=['exception'],eligible=True)
for field,index in [('sigma',0),('epsilon',1),('charge',2)]:
    for suffix,word,eligible in [('exact_limit',power(256),True),('next_above_limit',adjacent(power(256),1),False)]:
        f=fixture(3.5)
        for ep in ['a','b']:
            for i in range(2):
                f[ep]['nonbonded'][i][index]=word
                if field=='charge' and i==1: f[ep]['nonbonded'][i][index]='0x'+(int(word,16)|(1<<127)).to_bytes(16,'big').hex()
        add(f'guard_{field}_{suffix}',f,'Boundary of the per-evaluation2^256 bound; outside-cutoff legacy arithmetic stays finite.',tags=['guard-boundary'],eligible=eligible)
for name,index,word,expected in [('epsilon_product_overflow_fallback',1,power(8192),'revert:NonFinite'),('sigma_sum_overflow_fallback',0,power(16383),'revert:NonFinite'),('huge_sigma_zero_strength_fallback',0,power(9000),'success')]:
    f=fixture(3.5)
    for ep in ['a','b']:
        for row in f[ep]['nonbonded']:
            row[index]=word
            if name=='huge_sigma_zero_strength_fallback':row[1]=Z
    add(name,f,'Legacy particle mixing occurs before cutoff and its finite result or overflow must be preserved through ineligible fallback.',outcomes={'0':expected},tags=['extreme','fallback'],eligible=False)
f=fixture(3.5)
for ep in ['a','b']:
    f[ep]['nonbonded'][0][1]=power(9000);f[ep]['nonbonded'][1][1]=Z
add('huge_single_epsilon_zero_partner_fallback',f,'Huge finite epsilon times zero mixes to zero. Conservative guard must fall back without inventing failure.',tags=['extreme','fallback'],eligible=False)
f=fixture(0)
for ep in ['a','b']:
    for row in f[ep]['nonbonded']:row[1]=Z
f['positions']=[[power(300),Z,Z],[power(300),Z,Z]]
add('huge_common_translation_inactive_fallback',f,'Huge identical positions subtract to exactzero; inactive legacy pair succeeds.',tags=['extreme','fallback'],eligible=False)
f=copy.deepcopy(f);f['positions'][1][0]=power(300,negative=True)
add('huge_coordinate_image_range_fallback',f,'Huge opposite positions in a small box retain legacy ImageRangeExceeded.',outcomes={'0':'revert:ImageRangeExceeded'},tags=['extreme','fallback'],eligible=False)
f=fixture()
for ep in ['a','b']:
    for row in f[ep]['nonbonded']:row[1]=Z
f['box']=[power(9000),power(-9000),O];f['positions'][1][0]=power(8500);f['switchDistance']=power(-9003);f['cutoff']=power(-9002);f['alpha']=O
add('anisotropic_huge_box_inactive_legacy_success',f,'Box volume evaluates1in canonical x/y/z order. Legacy zero-strength pair skips overflowing norm and full evaluation succeeds; an unguarded eager norm would revert.',tags=['extreme','fallback','guard-semantic-trap'],eligible=False)
for suffix,word,eligible in [('exact_limit',power(256),True),('next_above_limit',adjacent(power(256),1),False)]:
    f=fixture();f['box']=[word]*3;f['positions'][1][0]=power(254);f['switchDistance']=q(.5);f['cutoff']=O
    for ep in ['a','b']:
        for row in f[ep]['nonbonded']:row[1]=Z
    add(f'guard_box_{suffix}',f,'Large box boundary with all zero strengths; box volume and eligible squared norm are finite.',tags=['guard-boundary'],eligible=eligible)
f=fixture(3.5)
for ep in ['a','b']:
    for row in f[ep]['nonbonded']:row[2]=power(8192)
add('huge_charge_self_overflow_fallback',f,'The original Atoms/self-energy stage already overflows q^2; optimization must retain the original failure.',outcomes={'0':'revert:NonFinite'},tags=['extreme','fallback'],eligible=False)
f=fixture();f['positions'][1]=[O,q(2),q(2)]
add('multi_axis_exact_cutoff',f,'Ordered x/y/z norm1+4+4 gives exactdistance3 at cutoff.',tags=['boundary','norm-order'],eligible=True)
f=fixture(11)
add('periodic_image_exact_cutoff',f,'Minimum-image displacement of11 in box8 is3, exactly at cutoff.',tags=['boundary','periodic'],eligible=True)
f=fixture(4)
add('ordinary_half_box_outside_cutoff',f,'Ordinary minimum-image half-box tie is valid and beyond cutoff; do not apply the stricter bonded exception tie guard.',tags=['boundary','periodic'],eligible=True)

# Structural checks only: these are input checks, not evaluator execution.
assert len({c['id'] for c in cases}) == len(cases)
for c in cases:
    f=c['source'];assert len(f['positions'])==2 and all(len(p)==3 for p in f['positions'])
    for ep in ['a','b']:
        assert len(f[ep]['particles'])==len(f[ep]['nonbonded'])==2
        assert all(len(row)==4 for row in f[ep]['particles']) and all(len(row)==3 for row in f[ep]['nonbonded'])
        assert f[ep]['bonds']==f[ep]['angles']==f[ep]['torsions']==[]
        for row in f[ep]['exceptions']:assert row[:2]==[0,1] and row[2] in [1,2]
    def valid(value):
        if isinstance(value,str):assert value.startswith('0x') and len(value)==34 and ((int(value,16)>>112)&0x7fff)!=0x7fff
        elif isinstance(value,list):
            for v in value:valid(v)
        elif isinstance(value,dict):
            for v in value.values():valid(v)
        else:assert isinstance(value,int)
    valid(f);valid(c['lambdas'])
core_names = {
    'below_switch','switch_prev_binary128','switch_next_binary128',
    'cutoff_prev_binary128','cutoff_exact','cutoff_next_binary128',
    'charged_only_inside','charged_only_outside','inactive_overlap',
    'active_LJ_overlap','active_charge_overlap','softcore_overlap_endpoint_and_interior',
    'underflow_norm_active_LJ','underflow_norm_inactive','native_B_parameter_projection',
    'hybrid_charges_inside','hybrid_charges_outside','hybrid_ghost_overlap',
    'direct_exception_beyond_cutoff','excluded_exception_beyond_cutoff',
    'direct_exception_overlap','excluded_exception_overlap',
    'epsilon_product_overflow_fallback','sigma_sum_overflow_fallback',
    'huge_sigma_zero_strength_fallback','huge_single_epsilon_zero_partner_fallback',
    'huge_common_translation_inactive_fallback','huge_coordinate_image_range_fallback',
    'anisotropic_huge_box_inactive_legacy_success','huge_charge_self_overflow_fallback',
}
assert len(core_names) == 30
for c in cases:
    c['name'] = c.pop('id')
    c['states'] = c.pop('statesToEvaluate')
    c['expectedOutcome'] = c.pop('expectedOutcomes')
extended_cases = [c for c in cases if c['name'] not in core_names]
cases = [c for c in cases if c['name'] in core_names]
assert len(cases) == 30
report=dict(schema='orvia.outside-cutoff-equivalence-inputs.v1',purpose='Exact-byte baseline/candidate evaluator engineering fixtures, not scientific molecular validation.',scalar_encoding='bytes16 binary128; native binary64 values embedded exactly; extreme powers and adjacent binary128 words constructed explicitly.',source_files=source_records,cases=cases,case_count=len(cases),evaluations_per_implementation=sum(len(c['states']) for c in cases),guard_review='No mathematical counterexample found under the full proposed≤2^256 bounds and identical ordered norm/sqrt comparison. Unsafe inputs must execute the unchanged legacy path. Exceptions untouched. Underflow and anisotropic-box traps are included.',scientific_optimizer_run=False,baseline_candidate_executed=False)
p=OUT/'cases.json';p.write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
extended_report = dict(report, cases=extended_cases, case_count=len(extended_cases), evaluations_per_implementation=sum(len(c['states']) for c in extended_cases), purpose='Optional additional threshold/periodic/underflow coverage; primary suite is cases.json.')
(OUT/'extended-cases.json').write_text(json.dumps(extended_report,indent=2,sort_keys=True)+'\n')

print(json.dumps(dict(path=str(p),sha256=sha(p),cases=len(cases),evaluations_per_implementation=report['evaluations_per_implementation']),indent=2))
