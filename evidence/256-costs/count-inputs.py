from pathlib import Path
import gzip, hashlib, json
import numpy as np

root = Path('/Users/abhijith/Documents/ChatGPT/AURA/output/full-hybrid-inputs')
out = Path(__file__).parent
unique = {}
for leg in ('complex33', 'solvent33'):
    manifest = json.loads((root / f'legs/{leg}/catalog-candidate.json').read_text())
    for name, row in manifest['streams'].items():
        sid = row['proposedStreamId']
        if sid in unique:
            assert unique[sid]['descriptor']['rawSha256'] == row['rawSha256']
            unique[sid]['aliases'].append(f'{leg}:{name}')
            continue
        unique[sid] = {'id': sid, 'aliases': [f'{leg}:{name}'], 'descriptor': row}

rows = []
for sid, item in unique.items():
    d = item['descriptor']
    compressed = (root / d['path']).read_bytes()
    assert hashlib.sha256(compressed).hexdigest() == d['gzipSha256']
    raw = gzip.decompress(compressed)
    assert len(raw) == d['rawBytes'] == d['wordCount'] * 32
    assert hashlib.sha256(raw).hexdigest() == d['rawSha256']
    a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 32)
    nonzero_words = int(np.count_nonzero(np.any(a != 0, axis=1)))
    nonzero_bytes = int(np.count_nonzero(a))
    batches = (len(a) + 127) // 128
    # Retain representative real payloads, not full duplicated model files.
    first = raw[:4096]
    (out / f'sample-{len(rows)}.bin').write_bytes(first)
    rows.append({'id': sid, 'aliases': item['aliases'], 'sourceGzip': d['path'],
        'rawSha256': d['rawSha256'], 'words': len(a), 'nonzeroWords': nonzero_words,
        'zeroWords': len(a) - nonzero_words, 'nonzeroBytes': nonzero_bytes,
        'zeroBytes': len(raw) - nonzero_bytes, 'appendTransactions': batches,
        'finalBatchWords': len(a) % 128 or 128, 'sampleFile': f'sample-{len(rows)}.bin'})

report = {'schemaVersion': 1, 'status': 'source_bytes_verified_counts_only',
    'scope': '24 distinct already assembled candidate input streams only. Excludes unresolved C4/activity/phase/constraint additions, topology/campaign registration and simulation.',
    'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'streams': rows, 'streamCount': len(rows),
    'totals': {key: sum(r[key] for r in rows) for key in
        ('words', 'nonzeroWords', 'zeroWords', 'nonzeroBytes', 'zeroBytes', 'appendTransactions')},
    'beginAndSealTransactions': len(rows) * 2,
    'scientificAcceptance': False, 'publicTransactionsSent': 0}
assert report['totals']['words'] == 10903836
(out / 'input-byte-counts.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'streams': len(rows), **report['totals'], 'beginAndSeal': len(rows) * 2}))
