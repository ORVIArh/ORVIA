#!/usr/bin/env python3
"""Preserve parameter-analogy evidence and fail scientific acceptance closed."""
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
DIRECTORY=ROOT/'data/prepared_candidate/ligand_endpoints_v0_1'

def audit(directory=DIRECTORY):
    rows={}
    for endpoint in ['A','B']:
        path=directory/endpoint/'ligand.frcmod';entries=[];section=''
        for number,line in enumerate(path.read_text().splitlines(),1):
            if line.strip() in ['MASS','BOND','ANGLE','DIHE','IMPROPER','NONBON']:section=line.strip()
            match=re.search(r'penalty score\s*=\s*([0-9.]+)',line)
            if match and float(match[1])>100:
                entries.append(dict(source_line=number,section=section,penalty_score=float(match[1]),source_text=line))
        rows[endpoint]=dict(source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),high_analogy_records=entries,
            native_tleap_errors=0,scientific_parameter_acceptance=False)
    result=dict(schema='orvia.ligand-parameter-review.v1',status='PARAMETER_QUALITY_REVIEW_REQUIRED',
        review_trigger='Native parmchk2 analogy score >100 triggers explicit review. This is a conservative workflow trigger, not a calibrated physical-error threshold.',
        endpoints=rows,
        preregistered_validation=dict(
            scope='Validate every high-analogy torsion family before accepting a production force-field model.',
            quantum_reference='Independent declared electronic-structure method/basis and constrained relaxed conformers; method is not yet selected or executed.',
            cyclic_terms='Use ring-preserving conformers or constrained puckering; never rotate a ring bond as if it were an acyclic rotor.',
            comparisons='Relative conformer energies and gradients; preserve failed calculations and separate bonded/nonbonded contributions.',
            acceptance_tolerances=None,
            sensitivity='Predeclare half/double amplitudes for flagged Fourier components as exploratory sensitivity variants. These are not statistical error bars and do not substitute for quantum validation.',
            production_sensitivity_execution='Any retained full binding calculation remains an explicitly registered on-chain protocol; no local calculation is substituted as its production result.'),
        numerical_translation_checks='Separate independent energy/force tests pass; they do not establish empirical parameter quality.',
        production_ready=False)
    (directory/'parameter_quality_review.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n');return result
if __name__=='__main__':
    result=audit();print(json.dumps({'status':result['status'],'high_analogy_records':{k:len(v['high_analogy_records']) for k,v in result['endpoints'].items()},'production_ready':False}))
