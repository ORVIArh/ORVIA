#!/usr/bin/env python3
"""Read-only Robinhood Chain connectivity and fee preflight. Never signs or sends."""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com'
CHAIN_ID = 4663
READS = [('eth_chainId', []), ('eth_getBlockByNumber', ['latest', False]), ('eth_gasPrice', [])]


def probe(endpoint, timeout=15):
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Use an HTTPS RPC endpoint without embedded user credentials.')
    output = []
    for index, (method, params) in enumerate(READS, 1):
        request = urllib.request.Request(endpoint, data=json.dumps({
            'jsonrpc': '2.0', 'id': index, 'method': method, 'params': params
        }).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        row = {'method': method, 'read_only': True}
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = json.load(response)
            if value.get('id') != index or value.get('jsonrpc') != '2.0':
                row['status'] = 'invalid_rpc_envelope'
            elif 'error' in value:
                row.update(status='rpc_error', error_code=value['error'].get('code'))
            elif method == 'eth_getBlockByNumber':
                block = value.get('result')
                if not isinstance(block, dict):
                    row['status'] = 'invalid_block'
                else:
                    row.update(status='ok', result={k: block.get(k) for k in
                        ['number', 'hash', 'timestamp', 'gasLimit', 'gasUsed', 'baseFeePerGas']})
            else:
                quantity = value.get('result')
                if not isinstance(quantity, str) or not quantity.startswith('0x'):
                    row['status'] = 'invalid_quantity'
                else:
                    row.update(status='ok', result=quantity, decimal=str(int(quantity, 16)))
        except urllib.error.HTTPError as exc:
            row.update(status='http_error', http_status=exc.code)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError, KeyError) as exc:
            # Do not leak a provider API key through exception text or URLs.
            row.update(status='transport_or_decode_error', error_type=type(exc).__name__)
        output.append(row)
    observed = int(output[0]['decimal']) if output[0].get('status') == 'ok' else None
    verified = observed == CHAIN_ID and all(r['status'] == 'ok' for r in output)
    now = datetime.now(timezone.utc)
    return {
        'checked_at_utc': now.isoformat(),
        'as_of_date_india': now.astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat(),
        'target_chain_id': CHAIN_ID,
        'endpoint': endpoint if endpoint == DEFAULT_RPC else f'https://{parsed.hostname}/[provider-path-redacted]',
        'endpoint_source': 'official_public' if endpoint == DEFAULT_RPC else 'operator_environment',
        'mode': 'read_only', 'transactions_sent': 0, 'fork_validation_performed': False,
        'chain_id_observed': observed, 'status': 'verified_read_only' if verified else 'blocked_or_inconclusive',
        'checks': output,
        'documented_limits': {'runtime': '96 KB', 'initcode': '192 KB',
            'planning_runtime_bytes': 96 * 1024, 'planning_initcode_bytes': 192 * 1024,
            'exact_chain_configuration_verified': False},
        'fee_scope': 'A live eth_estimateGas quote for each exact transaction is still required; local EVM gas does not include Robinhood L1 data fees.',
        'sources': ['https://docs.robinhood.com/chain/connecting/',
                    'https://docs.robinhood.com/chain/differences-from-ethereum/',
                    'https://docs.robinhood.com/chain/gas-and-fees/',
                    'https://docs.robinhood.com/chain/deploy-smart-contracts/']
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('reports/mainnet_preflight.json'))
    parser.add_argument('--timeout', type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 30:
        parser.error('timeout must be 1–30 seconds')
    report = probe(os.environ.get('ORVIA_RPC_URL', DEFAULT_RPC), args.timeout)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(args.output), 'status': report['status'],
                      'chain_id_observed': report['chain_id_observed'], 'transactions_sent': 0}))
    return 0 if report['status'] == 'verified_read_only' else 2


if __name__ == '__main__':
    raise SystemExit(main())
