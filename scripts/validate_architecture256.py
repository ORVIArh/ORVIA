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
    standalone = [entry for entry in core if entry.get('status') == 'raw_primitive_validated_alchemical_integration_required']
    check(len(connected) == 31 and [entry['id'] for entry in standalone] == ['K16'],
          'expected 31 molecular-path candidates plus the standalone C4 primitive')
    check(model.get('molecularPathCoreCount') == len(connected) and model.get('standaloneComponentSlots') == ['K16'],
          'component integration summary is inconsistent')
    for entry in core:
        file = (ROOT / entry.get('source', '')).resolve()
        check(file.is_relative_to(ROOT) and file.is_file(), f"missing candidate source for {entry['id']}")
    expected = [('D', 'C02', 96), ('W', 'C05', 64), ('F', 'C06', 64)]
    check([(p.get('id'), p.get('routerSlot'), p.get('count')) for p in pools] == expected,
          'bank allocation or owning routers changed')
    check(all(p.get('routerSlot') in ids for p in pools), 'bank router must itself be counted')
    count = len(core) + sum(p.get('count', 0) for p in pools)
    check(count == 256, 'actual core plus child-bank total differs from 256')
    check(model.get('prototypeInventoryCoreCount') == len(core)
          and model.get('prototypeInventoryAddressCount') == len(core) + 224,
          'prototype inventory must include every core component and child bank')
    check(model.get('counts') == {'core': 32, 'inputBanks': 96, 'pipelineStateBanks': 64,
          'hamiltonianOutputBanks': 64, 'total': 256}, 'count summary is inconsistent')
    check(model.get('readyForMainnet') is False and model.get('scientificModelAccepted') is False,
          'allocation validation cannot promote readiness or scientific acceptance')
    check(model.get('physicalModelFullyIntegrated') is False, 'C4 physical composition remains incomplete')
    # Count and source claims require actual deployment and integration evidence.
    try:
        report = json.loads((ROOT / model['validatedLocalReport']).read_text())
        inventory_bytes = (ROOT / model['deploymentInventory']).read_bytes()
        inventory = json.loads(inventory_bytes)
        check(report.get('passed') is True and report.get('actualLocalAddresses') == 256,
              'missing passing 256-address local integration report')
        check(report.get('deploymentInventorySha256') == hashlib.sha256(inventory_bytes).hexdigest(),
              'integration report does not bind the deployment inventory')
        check(report.get('noChildContractsCreatedDuringRuns') is True, 'unbounded child creation not ruled out')
        check(report.get('rawC4', {}).get('standaloneOnly') is True
              and report.get('rawC4', {}).get('integratedAlchemicalC4') is False,
              'C4 integration scope must remain explicit')
        deployed = inventory.get('core', [])
        banks = inventory.get('banks', [])
        check(len(deployed) == 32 and len(banks) == 224, 'wrong deployed core/bank totals')
        addresses = [row['address'].lower() for row in deployed + banks]
        check(len(addresses) == len(set(addresses)) == 256, 'deployed addresses are not 256 distinct contracts')
        check(sorted(row['contract'] for row in deployed) == sorted(entry['contract'] for entry in core),
              'deployed contract responsibilities do not match the architecture')
        for name, expected_count in [('input', 96), ('pipeline', 64), ('hamiltonian', 64)]:
            check(sorted(row['index'] for row in banks if row['pool'] == name) == list(range(expected_count)),
                  f'incomplete {name} bank inventory')
        for file, digest in report['compilation']['sourceSha256'].items():
            source = (ROOT / file).resolve()
            check(source.is_relative_to(ROOT) and source.is_file()
                  and hashlib.sha256(source.read_bytes()).hexdigest() == digest,
                  f'compiled source changed since 256-address validation: {file}')
    except (KeyError, OSError, ValueError, TypeError) as error:
        errors.append(f'256-address evidence unavailable or malformed: {error}')
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
          'targetActualContracts': 256, 'prototypeInventoryContracts': model.get('prototypeInventoryAddressCount'),
          'architectureSha256': hashlib.sha256(raw).hexdigest(), 'errors': errors}, indent=2))
    raise SystemExit(2 if errors else 0)
