#!/usr/bin/env python3
"""Validate the active address allocation; this is not a production readiness pass."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate(model):
    errors = []
    def check(condition, message):
        if not condition:
            errors.append(message)
    check(model.get('architecture') == 'ORVIA-256', 'wrong active architecture')
    check(model.get('targetChainId') == 4663, 'wrong target chain')
    check(model.get('targetActualContractCount') == 256, 'target must count 256 actual contracts')
    check(model.get('productionExecution') == 'entirely_onchain_from_registered_inputs', 'production must remain on-chain')
    check(model.get('fundingCapUsd') is None, 'no dollar cap was requested')
    check(model.get('singleResultAnchorSelected') is False, 'single-anchor substitution is not selected')
    core, pools = model.get('core', []), model.get('bankPools', [])
    check(len(core) == 32, 'expected 32 concrete core responsibilities')
    ids = [entry.get('id') for entry in core]
    check(len(set(ids)) == len(ids), 'duplicate core slot')
    check(all(entry.get('purpose') and entry.get('contract') for entry in core), 'missing core responsibility')
    connected = [entry for entry in core if entry.get('status') == 'candidate_not_production_validated']
    check(len(connected) == 24, 'connected prototype inventory changed; reconcile the allocation')
    for entry in connected:
        file = (ROOT / entry.get('source', '')).resolve()
        check(file.is_relative_to(ROOT) and file.is_file(), f"missing candidate source for {entry['id']}")
    expected = [('D', 'C02', 96), ('W', 'C05', 64), ('F', 'C06', 64)]
    check([(p.get('id'), p.get('routerSlot'), p.get('count')) for p in pools] == expected,
          'bank allocation or owning routers changed')
    check(all(p.get('routerSlot') in ids for p in pools), 'bank router must itself be counted')
    count = len(core) + sum(p.get('count', 0) for p in pools)
    check(count == 256, 'actual core plus child-bank total differs from 256')
    check(model.get('connectedPrototypeExpectedAddressCount') == len(connected) + 224,
          'prototype count must include every child bank')
    check(model.get('counts') == {'core': 32, 'inputBanks': 96, 'pipelineStateBanks': 64,
          'hamiltonianOutputBanks': 64, 'total': 256}, 'count summary is inconsistent')
    check(model.get('readyForMainnet') is False and model.get('scientificModelAccepted') is False,
          'allocation validation cannot promote readiness or scientific acceptance')
    return errors


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--require-ready', action='store_true')
    args = parser.parse_args()
    raw = (ROOT / 'data/architecture_256.json').read_bytes()
    model = json.loads(raw)
    errors = validate(model)
    if args.require_ready:
        errors.append('ORVIA-256 still requires full core integration, scientific acceptance and complete deployment evidence.')
    print(json.dumps({'designValid': not validate(model), 'readyForMainnet': False,
          'targetActualContracts': 256, 'prototypeExpectedContracts': 248,
          'architectureSha256': hashlib.sha256(raw).hexdigest(), 'errors': errors}, indent=2))
    raise SystemExit(2 if errors else 0)
