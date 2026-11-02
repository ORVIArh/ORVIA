#!/usr/bin/env python3
"""Package only explicitly listed benchmark code and molecular inputs."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--full-inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = {}
    for name in ('validate_endpoints.py', 'benchmark_system.py', 'run_benchmark.py',
                 'export_native_candidates.py', 'prepare_bundle.py', 'requirements-cuda.txt', 'README.md'):
        files['scripts/' + name] = args.repo_root / 'scripts/cloud_gpu' / name
    for endpoint in ('A', 'B'):
        for name in ('system.xml', 'parameters.json'):
            files[f'inputs/endpoints/{endpoint}/{name}'] = (
                args.repo_root / 'data/prepared_candidate/ligand_endpoints_v0_1' / endpoint / name)
    for leg in ('complex33', 'solvent33'):
        for name in ('system.xml', 'positions.json', 'provenance.json'):
            files[f'inputs/full/{leg}/{name}'] = args.full_inputs / leg / name
    payloads = {name: source.read_bytes() for name, source in files.items()}
    manifest = {
        'schema': 'orvia.cloud-benchmark-bundle.v1',
        'purpose': 'CUDA endpoint checks and fixed-coordinate full-size candidate force timings',
        'scientific_acceptance': False, 'production_ready': False,
        'original_ORVIA_001_replacement_approved': False,
        'full_campaign_cost': None, 'onchain_contract_target': 256,
        'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                  for name, data in sorted(payloads.items())},
        'note': 'No wallet, RPC configuration, cloud credentials, trajectories, or environment files included.',
    }
    payloads['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + '.tmp')
    with tarfile.open(temporary, 'w:gz') as archive:
        for name, data in sorted(payloads.items()):
            info = tarfile.TarInfo('orvia-benchmark/' + name)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    temporary.replace(args.output)
    print(json.dumps({'archive': str(args.output), 'bytes': args.output.stat().st_size,
                      'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
                      'files': len(payloads), 'production_ready': False}))


if __name__ == '__main__':
    main()
