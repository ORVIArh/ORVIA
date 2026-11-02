#!/usr/bin/env python3
"""Freeze canonical Solidity bytes and build an isolated guarded-cutoff candidate."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
CANONICAL=ROOT/'ORVIA'
TARGET='contracts/core/AlchemicalHamiltonianEvaluator.sol'


def digest(data):return hashlib.sha256(data).hexdigest()


def main():
    snapshot=OUT/'baseline-sources.json'
    if snapshot.exists():
        raise RuntimeError('Existing baseline is retained; do not silently refresh it.')
    paths=sorted((CANONICAL/'contracts').rglob('*.sol'))
    sources={str(path.relative_to(CANONICAL)):dict(content=path.read_text()) for path in paths}
    for path in paths:
        assert path.read_text()==sources[str(path.relative_to(CANONICAL))]['content'],'Source changed during capture'
    snapshot.write_text(json.dumps(sources,indent=2,sort_keys=True)+'\n')
    baseline=sources[TARGET]['content']
    changes=[
      ('bytes16 lambda; bytes16 totalCharge; bool anyCharge;',
       'bytes16 lambda; bytes16 totalCharge; bool anyCharge; bool fastCutoffEligible;'),
      ('r.lambda = catalog.lambdaAt(input.topology, input.state); r.modes = _modeCount(d.ewaldExtent);',
       'r.lambda = catalog.lambdaAt(input.topology, input.state); r.modes = _modeCount(d.ewaldExtent);\n        r.fastCutoffEligible = _cutoffBounded(d.box[0]) && _cutoffBounded(d.box[1]) && _cutoffBounded(d.box[2]);'),
      ('_position(r, uint32(r.cursor)); bytes16 q = _charge(r, d, uint32(r.cursor));',
       'bytes16[3] memory position = _position(r, uint32(r.cursor)); bytes16 q = _charge(r, d, uint32(r.cursor));'),
      ('_energy(r, d, 6, EwaldCorrections(modules.corrections).selfEnergy(q, d.ewaldAlpha, d.prefactor));',
       '_energy(r, d, 6, EwaldCorrections(modules.corrections).selfEnergy(q, d.ewaldAlpha, d.prefactor));\n            if (r.fastCutoffEligible && !_cutoffAtomSafe(d, uint32(r.cursor), position, q)) r.fastCutoffEligible = false;'),
      ('bytes16[3] memory displacement = _displacement(r, d, a, b);\n        Pair memory p; p.a = a; p.b = b;',
       '''bytes16[3] memory displacement = _displacement(r, d, a, b);
        if (r.fastCutoffEligible) {
            FloatMath m = FloatMath(modules.math);
            bytes16 squared;
            for (uint256 k; k < 3; ++k) squared = m.add(squared, m.mul(displacement[k], displacement[k]));
            // Same ordered binary128 r^2 and sqrt as the legacy LJ/Ewald
            // branches. Never substitute a rounded cutoff-squared comparison.
            if (m.compare(m.sqrt(squared), d.cutoff) >= 0) return;
        }
        Pair memory p; p.a = a; p.b = b;'''),
      ('    function _exceptionPair(Run storage r, AlchemicalTopologyCatalog.Definition memory d, Pair memory p) private {',
       '''    // Eligibility only removes arithmetic known to be finite outside the
    // cutoff. Extreme admitted inputs retain every legacy failure path.
    function _cutoffBounded(bytes16 value) private pure returns (bool) {
        return (uint128(value) & 0x7fffffffffffffffffffffffffffffff) <= 0x40ff0000000000000000000000000000; // abs <= 2^256
    }
    function _cutoffAtomSafe(AlchemicalTopologyCatalog.Definition memory d, uint32 atom, bytes16[3] memory position, bytes16 charge) private view returns (bool) {
        if (!_cutoffBounded(position[0]) || !_cutoffBounded(position[1]) || !_cutoffBounded(position[2]) || !_cutoffBounded(charge)) return false;
        uint64 offset = uint64(atom) * 3;
        return _cutoffBounded(_value(d.a.nonbonded, offset)) && _cutoffBounded(_value(d.a.nonbonded, offset + 1))
            && _cutoffBounded(_value(d.b.nonbonded, offset)) && _cutoffBounded(_value(d.b.nonbonded, offset + 1));
    }
    function _exceptionPair(Run storage r, AlchemicalTopologyCatalog.Definition memory d, Pair memory p) private {''')]
    candidate=baseline
    for before,after in changes:
        assert candidate.count(before)==1,before
        candidate=candidate.replace(before,after)
    (OUT/'AlchemicalHamiltonianEvaluator.baseline.sol').write_text(baseline)
    (OUT/'AlchemicalHamiltonianEvaluator.candidate.sol').write_text(candidate)
    report=dict(schema='orvia.guarded-outside-cutoff-candidate.v1',status='unvalidated_candidate',canonical_modified=False,
        canonical_revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=CANONICAL,text=True).strip(),
        baseline_source_sha256=digest(baseline.encode()),candidate_source_sha256=digest(candidate.encode()),
        baseline_sources={name:digest(value['content'].encode()) for name,value in sources.items()},
        policy='Original FloatMath/ABDK binary128. No Fixed96 substitution. Pair order and exceptions unchanged.',
        eligibility='All box lengths, consumed atom positions, interpolated charges and both endpoint sigma/epsilon magnitudes <=2^256, accumulated during existing atom work. Any unsafe input disables shortcut for the whole evaluation.',
        native_pair_input_sha256=digest((ROOT/'output/gas-estimate/outside-pair-input.json').read_bytes()))
    (OUT/'candidate-preparation.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='baseline_sources'},indent=2))


if __name__=='__main__':main()
