#!/usr/bin/env python3
"""Snapshot and analyze a fresh CPU campaign using its frozen original analyzer.

The running campaign is only read. Failed and unfinished observations remain in
its inventory, and historical failed results are never substituted for new ones.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from reproduce import POLICY_SHA, jobs, verify


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def strict_read(path):
    def invalid(value):
        raise ValueError('Nonfinite JSON numeric token: ' + value)
    return json.loads(Path(path).read_text(), parse_constant=invalid)


def completed_record(record, descriptor, name, worker_sha):
    """Reject a completed label unsupported by its worker's evidence."""
    if record.get('job') != name or record.get('policy_sha256') != POLICY_SHA:
        raise ValueError('Job identity/policy mismatch: ' + name)
    if record.get('status') != 'completed':
        return
    if record.get('runner_sha256') != worker_sha:
        raise ValueError('Completed observation uses another worker: ' + name)
    if record.get('runtime', {}).get('backend') != 'CPU OpenBLAS':
        raise ValueError('Expected independent CPU result: ' + name)
    if record.get('initial_scf_converged') is not True or record.get('final_scf_converged') is not True:
        raise ValueError('Completed observation lacks SCF convergence: ' + name)
    if descriptor['optimize'] and record.get('geometry_converged') is not True:
        raise ValueError('Completed observation lacks geometry convergence: ' + name)
    if record.get('input_sha256') != hashlib.sha256(descriptor['_source_bytes']).hexdigest():
        raise ValueError('Completed observation input hash mismatch: ' + name)
    if not record.get('ring_bonds') or any(row.get('passed') is not True for row in record['ring_bonds']):
        raise ValueError('Completed observation lacks passed ring checks: ' + name)
    n = len(descriptor['symbols'])
    positions = record.get('positions_angstrom', [])
    if len(positions) != n or any(len(row) != 3 or any(not math.isfinite(x) for x in row) for row in positions):
        raise ValueError('Completed observation has invalid coordinates: ' + name)
    values = [record.get('energy_hartree'), record.get('energy_kJ_per_mol'), record.get('mm_reference', {}).get('energy_kJ_per_mol')]
    if any(not isinstance(x, (float, int)) or isinstance(x, bool) or not math.isfinite(x) for x in values):
        raise ValueError('Completed observation has invalid energies: ' + name)


def analyze(campaign, output):
    campaign = campaign.resolve(); output = output.resolve()
    if output == campaign or output in campaign.parents or campaign in output.parents:
        raise ValueError('Use a separate output directory outside the running campaign')
    verify(campaign)
    output.mkdir(parents=True, exist_ok=False)
    manifest = strict_read(campaign / 'input-manifest.json')
    snapshot = output / 'snapshot'
    for relative in manifest['files']:
        destination = snapshot / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(campaign / relative, destination)
    shutil.copyfile(campaign / 'input-manifest.json', snapshot / 'input-manifest.json')
    relative = Path('data/prepared_candidate/quantum')
    frozen_worker = sha(snapshot / 'scripts/quantum_corrected/worker.py')
    names = jobs(strict_read(snapshot / relative / 'quality_policy.json'))
    observed = []
    for name in names:
        source = campaign / relative / 'jobs' / name
        target = snapshot / relative / 'jobs' / name
        result = source / 'result.json'
        if not result.exists():
            observed.append(dict(job=name, status='missing', sha256=None)); continue
        # Worker replaces result.json atomically; capture exactly one generation.
        raw = result.read_bytes()
        target.mkdir(parents=True)
        (target / 'result.json').write_bytes(raw)
        record = strict_read(target / 'result.json')
        descriptor = {}
        if (source / 'input.json').exists():
            raw_input = (source / 'input.json').read_bytes()
            (target / 'input.json').write_bytes(raw_input)
            descriptor = strict_read(target / 'input.json')
            descriptor['_source_bytes'] = raw_input
        completed_record(record, descriptor, name, frozen_worker)
        observed.append(dict(job=name, status=record['status'], sha256=sha(target / 'result.json')))
    # The frozen analyzer's equations, training split, and thresholds are reused.
    module_path = snapshot / 'scripts/quantum/analyze_scans.py'
    spec = importlib.util.spec_from_file_location('frozen_orvia_quantum_analyzer', module_path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with contextlib.redirect_stdout(io.StringIO()):
        module.main()
    report = strict_read(snapshot / relative / 'quality_analysis.json')
    report.update(schema='orvia.corrected-qm-analysis.v1', scientific_acceptance=False,
        source_campaign=str(campaign), input_manifest_sha256=sha(snapshot / 'input-manifest.json'),
        wrapper_sha256=sha(__file__), frozen_analyzer_sha256=sha(module_path),
        observations_snapshot=observed, original_observations_reused=False,
        original_failed_campaign_preserved=True, acceptance_limits_unchanged=True,
        gpu_observations_substituted=False,
        snapshot_note='Each worker result is captured atomically at its own read time; this is a progress snapshot, not a simultaneous checkpoint. The baseline is additional to the 26 quality jobs.')
    (output / 'quality_analysis.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    shutil.copyfile(snapshot / relative / 'curves.csv', output / 'curves.csv')
    shutil.copyfile(__file__, output / 'analyzer_wrapper_source.py')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = analyze(args.campaign, args.output)
    print(json.dumps({key: report[key] for key in ['status', 'calculation_counts', 'unresolved_reasons', 'scientific_acceptance']}, indent=2))
