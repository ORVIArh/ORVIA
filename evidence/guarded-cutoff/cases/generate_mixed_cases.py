"""Derive mixed-accumulation fixtures; all outputs remain beside this script."""
from pathlib import Path
from fractions import Fraction
from decimal import Decimal, localcontext
import copy, hashlib, json, struct
OUT = Path(__file__).resolve().parent
ROOT = Path('/Users/abhijith/Documents/ChatGPT/AURA/ORVIA')
REFERENCE = ROOT / 'reference/periodic_reference.json'
PATTERN = ROOT / 'test/molecular-pipeline.test.mjs'
PRIMARY = OUT / 'cases.json'
sha = lambda value: hashlib.sha256(value).hexdigest()
primary_before = PRIMARY.read_bytes()
primary = json.loads(primary_before)
reference_bytes = REFERENCE.read_bytes()
pattern_bytes = PATTERN.read_bytes()
reference = json.loads(reference_bytes)['inputs']
pattern_text = pattern_bytes.decode()
start = pattern_text.index('function richFixture(){')
end = pattern_text.index('\n}', start) + 2
rich_pattern = pattern_text[start:end]

def q(value):
    bits = struct.unpack('>Q', struct.pack('>d', float(value)))[0]
    sign, exponent, mantissa = bits >> 63, (bits >> 52) & 2047, bits & ((1 << 52) - 1)
    assert exponent not in [0, 2047] or mantissa == 0
    word = 0 if exponent == 0 else (sign << 127) | ((exponent - 1023 + 16383) << 112) | (mantissa << 60)
    return '0x' + word.to_bytes(16, 'big').hex()

def exact(word):
    bits = int(word, 16)
    sign = -1 if bits >> 127 else 1
    exponent = (bits >> 112) & 32767
    mantissa = bits & ((1 << 112) - 1)
    assert exponent != 32767
    if exponent == 0:
        significand, power = mantissa, -16494
    else:
        significand, power = (1 << 112) + mantissa, exponent - 16383 - 112
    return sign * Fraction(significand) * (Fraction(2) ** power)

def exact_word(value):
    # All translated fixture coordinates are small dyadic values exactly binary64.
    word = q(float(value))
    assert exact(word) == value
    return word

def endpoint():
    return {key: copy.deepcopy(reference[key]) for key in ['particles','nonbonded','bonds','angles','torsions','exceptions']}

a = endpoint()
b = copy.deepcopy(a)
b['bonds'][0][2] = q(3)
b['angles'][0][3] = q(.75)
b['torsions'][0][5] = q(.375)
b['nonbonded'][0] = [q(.625), q(.1875), q(.25)]
b['nonbonded'][3][2] = q(-.125)
b['exceptions'][1][4] = q(.09375)
b['exceptions'][1][5] = q(-.0625)
source4 = dict(positions=copy.deepcopy(reference['positions']), a=a, b=b,
               box=copy.deepcopy(reference['box']), switchDistance=reference['switchDistance'],
               cutoff=reference['cutoff'], prefactor=reference['prefactor'], alpha=q(.75), extent=1, softcoreAlpha=q(.5))
source8 = copy.deepcopy(source4)
source8['positions'] = copy.deepcopy(source4['positions']) + [
    [exact_word(exact(row[0])), exact_word(exact(row[1])), exact_word(exact(row[2]) + 3)]
    for row in source4['positions']]
for ep in ['a', 'b']:
    for key in ['particles', 'nonbonded']:
        source8[ep][key] = copy.deepcopy(source4[ep][key]) * 2
    for key, atoms in [('bonds',2),('angles',3),('torsions',4),('exceptions',2)]:
        original = copy.deepcopy(source4[ep][key])
        source8[ep][key] = original + [[*(x+4 for x in row[:atoms]), *copy.deepcopy(row[atoms:])] for row in original]

def classify(name, source):
    xyz = [[exact(v) for v in row] for row in source['positions']]
    box = [exact(v) for v in source['box']]
    switch, cutoff = exact(source['switchDistance']), exact(source['cutoff'])
    assert 0 < switch < cutoff and all(cutoff < length/2 for length in box)
    exceptions = {(r[0],r[1]):r[2] for r in source['a']['exceptions']}
    assert exceptions == {(r[0],r[1]):r[2] for r in source['b']['exceptions']}
    rows = []
    counts = dict(total_pairs=0,normal_pairs=0,normal_below_or_at_switch=0,normal_switched_inside_cutoff=0,
                  normal_outside_or_at_cutoff=0,direct_exception_pairs=0,excluded_exception_pairs=0)
    gaps = []
    for i in range(len(xyz)):
        for j in range(i+1,len(xyz)):
            displacement = []
            for axis in range(3):
                delta = xyz[j][axis] - xyz[i][axis]
                image = int(delta/box[axis])  # exact truncation toward zero
                remainder = delta - image*box[axis]
                if remainder > box[axis]/2: remainder -= box[axis]
                elif remainder < -box[axis]/2: remainder += box[axis]
                assert abs(remainder) <= box[axis]/2
                displacement.append(remainder)
            squared = sum((d*d for d in displacement), Fraction(0))
            assert squared > 0
            assert squared.numerator.bit_length() <= 113 and squared.denominator & (squared.denominator-1) == 0
            if (i,j) in exceptions:
                category = 'direct_exception' if exceptions[i,j] == 2 else 'excluded_exception'
                counts['direct_exception_pairs' if exceptions[i,j] == 2 else 'excluded_exception_pairs'] += 1
            elif squared <= switch*switch:
                category = 'normal_below_or_at_switch';counts[category] += 1;counts['normal_pairs'] += 1
            elif squared < cutoff*cutoff:
                category = 'normal_switched_inside_cutoff';counts[category] += 1;counts['normal_pairs'] += 1
            else:
                category = 'normal_outside_or_at_cutoff';counts[category] += 1;counts['normal_pairs'] += 1
            with localcontext() as context:
                context.prec = 100
                distance = (Decimal(squared.numerator)/Decimal(squared.denominator)).sqrt()
            rows.append(dict(ordered_pair_index=len(rows),atoms=[i,j],classification=category,
                exact_minimum_image_displacement=[str(v) for v in displacement],exact_squared_distance=str(squared),distance_decimal_100_digits=str(distance)))
            gaps.extend([abs(squared-switch*switch),abs(squared-cutoff*cutoff)])
            counts['total_pairs'] += 1
    assert counts['total_pairs'] == len(xyz)*(len(xyz)-1)//2
    assert counts['normal_pairs'] == counts['total_pairs']-len(exceptions)
    assert all(counts[k] > 0 for k in ['normal_below_or_at_switch','normal_switched_inside_cutoff','normal_outside_or_at_cutoff','direct_exception_pairs','excluded_exception_pairs'])
    return dict(name=name,atoms=len(xyz),counts=counts,exact_switch_squared=str(switch*switch),exact_cutoff_squared=str(cutoff*cutoff),
                minimum_squared_distance_boundary_gap=str(min(gaps)),minimum_nonzero_squared_distance_boundary_gap=str(min(g for g in gaps if g)),exact_cutoff_pair_count=sum(Fraction(r['exact_squared_distance'])==cutoff*cutoff for r in rows),exact_switch_pair_count=sum(Fraction(r['exact_squared_distance'])==switch*switch for r in rows),pair_order='Lexicographic a<b, matching evaluator _pairIndices.',pairs=rows)

classifications = [classify('rich_reference_4atom_mixed',source4),classify('duplicated_reference_8atom_mixed',source8)]
proof = dict(schema='orvia.mixed-pair-exact-classification.v1',method='Decode each binary128 input to an exact Fraction; perform minimum-image quotient truncation/remainder adjustment and squared-distance comparisons using rational arithmetic. Decimal square roots are inspection only.',
             floating_point_argument='All coordinate/box values and their minimum-image displacements are small dyadic rationals. Their ordered squared norm is exactly representable in binary128. Non-boundary pairs have reported exact positive rational gaps. Exact cutoff ties have r^2=9 and sqrt(r^2)=3 exactly; the legacy >= comparison classifies them outside. Exact ties are counted separately.',
             reference_sha256=sha(reference_bytes),rich_fixture_pattern_sha256=sha(rich_pattern.encode()),classifications=classifications,baseline_candidate_executed=False)
proof_path = OUT / 'mixed-classification.json'
proof_path.write_text(json.dumps(proof,indent=2,sort_keys=True)+'\n')

def case(name,source,description,derivation):
    return dict(name=name,source=source,lambdas=[q(0),q(.5),q(1)],states=[0,1,2],expectedOutcome={str(i):'success' for i in range(3)},
                description=description,expectedFastCutoffEligible=True,tags=['mixed-accumulation','reference-derived','bonded','exceptions','charged','endpoint-interior'],
                provenance=dict(kind='Frozen reference engineering model and richFixture derivation',derivation=derivation,
                    derived_source_sha256=sha((json.dumps(source,indent=2,sort_keys=True)+'\n').encode()),
                    reference_path=str(REFERENCE),reference_sha256=sha(reference_bytes),rich_fixture_path=str(PATTERN),
                    rich_fixture_file_sha256=sha(pattern_bytes),rich_fixture_pattern_sha256=sha(rich_pattern.encode()),
                    exact_pair_classification_path=str(proof_path),exact_pair_classification_sha256=sha(proof_path.read_bytes())),
                evidenceStatus='Generated input and exact rational classification; parent harness must execute full ordered baseline/candidate accumulation parity. No evaluator result is claimed here.')

cases = [case('rich_reference_4atom_mixed',source4,'Four-atom richFixture with normal below-switch, switched and outside-cutoff pairs plus one direct and one excluded pair; nonempty bonds/angles/torsion and changed endpoint parameters.',
              'Copy periodic_reference.inputs positions/box/particles/nonbonded/bonds/angles/torsions/exceptions. Apply exactly richFixture endpoint-B edits from test/molecular-pipeline.test.mjs. Use the same alpha=.75,extent=1,softcoreAlpha=.5.'),
         case('duplicated_reference_8atom_mixed',source8,'Two translated copies add16cross-copy normal interactions in the same lexicographic force/energy accumulation; both inside/outside and direct/excluded categories remain populated.',
              'Duplicate the complete four-atom rich fixture. Add4to atom indices in every copied bonded/exception record; retain periodicity integers and all parameter words. Translate only copied positions by exactly+3in z. Keep the original fixedbox8, cutoff3 and switch2; copied initial particle rows and parameter words are unchanged.')]
report = {key:copy.deepcopy(value) for key,value in primary.items() if key != 'cases'}
report.update(cases=cases,case_count=len(cases),evaluations_per_implementation=6,
              purpose='Supplementary full ordered mixed-accumulation parity fixtures, not scientific molecular validation.',
              source_files=dict(periodic_reference=dict(path=str(REFERENCE),bytes=len(reference_bytes),sha256=sha(reference_bytes)),
                                molecular_pipeline_rich_fixture=dict(path=str(PATTERN),bytes=len(pattern_bytes),sha256=sha(pattern_bytes),pattern_sha256=sha(rich_pattern.encode()))),
              guard_review='Both derived fixtures are within the reviewed2^256 eligibility domain; exact rational minimum-image classifications prove normal inside/outside and direct/excluded pair coverage. Parent harness must compare all final output words and advancement/revert traces.')
assert set(report) == set(primary)
assert all(set(c)==set(primary['cases'][0]) for c in cases)
output = OUT / 'mixed-cases.json'
output.write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
assert PRIMARY.read_bytes() == primary_before
print(json.dumps(dict(path=str(output),sha256=sha(output.read_bytes()),classification_path=str(proof_path),classification_sha256=sha(proof_path.read_bytes()),profiles=len(cases),evaluations_per_implementation=6,counts=[r['counts'] for r in classifications],primary_cases_unchanged_sha256=sha(primary_before)),indent=2))
