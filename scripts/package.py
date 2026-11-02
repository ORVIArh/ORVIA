#!/usr/bin/env python3
"""Package the validated checkpoint and verify every archived payload hash."""
import hashlib
import json
import subprocess
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'node_modules', '__pycache__', '.git', '.venv-research', '.venv'}
CHECKSUMS = 'reports/package_checksums.json'


def main():
    verification = subprocess.run(['node', 'scripts/validation_inventory.mjs', '--verify'],
                                  cwd=ROOT, text=True, capture_output=True)
    if verification.returncode != 0:
        raise SystemExit('Current complete validation is required before packaging:\n'
                         + verification.stdout + verification.stderr)
    verified = json.loads(verification.stdout)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if any(c not in '0123456789.' for c in version):
        raise SystemExit('Invalid package version.')
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and not p.is_symlink()
                   and not any(x in EXCLUDED for x in p.relative_to(ROOT).parts)
                   and not (p.name.startswith('.env') and p.name != '.env.example')
                   and not p.name.endswith('_targeted.log')
                   and p.suffix not in {'.pyc', '.zip'}
                   and p.relative_to(ROOT).as_posix() != CHECKSUMS)
    payloads = {p.relative_to(ROOT).as_posix(): p.read_bytes() for p in files}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
    # Verify the captured archive bytes, not just the disk state seen earlier.
    # These input exclusions mirror validation_inventory.mjs; mutation tests
    # exercise added/removed inputs and separately bound operational evidence.
    if hashes.get('reports/validation_summary.json') != verified['validationSummarySha256']:
        raise SystemExit('Validation summary changed while collecting the package.')
    summary = json.loads(payloads['reports/validation_summary.json'])
    roots = {'contracts', 'test', 'reference', 'scripts', 'data'}
    pins = {'package.json', 'package-lock.json', 'requirements-research.txt'}
    operational = {'data/production_acceptance.json', 'data/operator_deployment.json',
                   'data/production_slot_evidence.json'}
    def is_input(name):
        parts = Path(name).parts
        return (name in pins or parts[0] in roots) and name not in operational \
            and not name.startswith('data/production/') and '__pycache__' not in parts \
            and not name.endswith('.pyc')
    captured_inputs = {name: digest for name, digest in hashes.items() if is_input(name)}
    if captured_inputs != summary['inputInventory']:
        raise SystemExit('Captured package inputs differ from the validated inventory.')
    bound = {**summary['buildOutputs'], **summary['generatedEvidence'],
             **{check['log']: check['logSha256'] for check in summary['checks']}}
    if any(hashes.get(name) != digest for name, digest in bound.items()):
        raise SystemExit('Captured package artifacts or check logs differ from validation.')
    checksum_data = (json.dumps(hashes, indent=2) + '\n').encode()
    (ROOT / CHECKSUMS).write_bytes(checksum_data)
    payloads[CHECKSUMS] = checksum_data
    output = ROOT.parent / f'ORVIA-v{version}-source-and-validation.zip'
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payloads.items()):
            item = zipfile.ZipInfo(f'orvia/{name}', date_time=(2026, 11, 2, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o100644 << 16
            archive.writestr(item, data, compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(payloads)
        for name, expected in hashes.items():
            assert hashlib.sha256(archive.read('orvia/' + name)).hexdigest() == expected, name
    print(json.dumps({'file': str(output), 'files': len(payloads),
                      'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
