#!/usr/bin/env python3
"""One-use local unlock for a frozen GPU diagnostic connection plan.

Reuses the reviewed raw-PTY and loopback HTTP protections. No password, raw
transaction or child-process output is logged or returned by this bridge.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import threading

BASE_SHA = 'ec1c3e04a2132c9c864be613272f544c6b0a5396b9132e75be8dd0decf8f4956'
OWNER = '0x2541a9e93B5C853E9208b0C5C7386dD458424c77'
COORDINATOR = '0x3B188B4c5B76b009d80455D3bbB7597983E390f0'
DEPLOYMENT_FEE_WEI = 4612876889674000


def including_deployment(amount):
    whole, _, fraction = amount.partition('.')
    total = int(whole) * 10**18 + int(fraction.ljust(18, '0')) + DEPLOYMENT_FEE_WEI
    whole, fraction = divmod(total, 10**18)
    tail = str(fraction).zfill(18).rstrip('0')
    return str(whole) + ('.' + tail if tail else '')


def read_checked(file, maximum=4 * 1024 * 1024):
    file = Path(file)
    if file.resolve() != file.absolute():
        raise ValueError('Symlinked path')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 <= before.st_size <= maximum:
            raise ValueError('Invalid file')
        data = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        if len(data) != before.st_size or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
            raise ValueError('File changed')
        return data
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_manifest(file, expected):
    raw = read_checked(file)
    if len(expected) != 64 or digest(raw) != expected:
        raise ValueError('Frozen manifest changed')
    manifest = json.loads(raw)
    if manifest.get('schema') != 'orvia.gpu-connection.freeze.v1' or manifest.get('chainId') != 4663:
        raise ValueError('Wrong connection release')
    if manifest.get('owner') != OWNER or manifest.get('coordinator') != COORDINATOR:
        raise ValueError('Wrong owner or coordinator')
    if not re.fullmatch(r'[0-9a-f]{64}', manifest.get('planSha256', '')) or not re.fullmatch(r'0x[0-9a-f]{64}', manifest.get('runId', '')):
        raise ValueError('Invalid operation identity')
    required = [manifest['entrypoint'], manifest['planFile'], str(Path(__file__).resolve()),
                str(Path(__file__).resolve().parents[1] / 'deployment/local_unlock_market.py')]
    if any(path not in manifest['files'] for path in required):
        raise ValueError('Required source is not frozen')
    for path, record in manifest['files'].items():
        data = read_checked(path, 100 * 1024 * 1024)
        if len(data) != record['bytes'] or digest(data) != record['sha256']:
            raise ValueError('Frozen file changed')
    if str(Path(__file__).resolve()) not in manifest['files']:
        raise ValueError('Bridge is not bound to release')
    node = manifest['node']
    if digest(read_checked(node['path'], 200 * 1024 * 1024)) != node['sha256']:
        raise ValueError('Node executable changed')
    return manifest


def public_progress(file, manifest):
    data = json.loads(read_checked(file, 1024 * 1024))
    if data.get('planSha256') != manifest['planSha256'] or data.get('coordinator') != COORDINATOR:
        raise ValueError('Wrong progress identity')
    if data.get('diagnosticOnly') is not True or data.get('runId') != manifest['runId']:
        raise ValueError('Wrong diagnostic')
    result = {}
    for key in ['planSha256', 'coordinator', 'runId', 'stage', 'totalFeeEstimateEth', 'feeReserveEth', 'totalActualFeeEth', 'errorCode']:
        value = data.get(key)
        if value is not None:
            if not isinstance(value, str) or len(value) > 256:
                raise ValueError('Invalid public field')
            if key == 'errorCode' and not re.fullmatch(r'[a-z0-9_]{1,64}', value):
                raise ValueError('Invalid public error code')
            if key in ['totalFeeEstimateEth', 'feeReserveEth', 'totalActualFeeEth'] and not re.fullmatch(r'\d{1,30}(?:\.\d{1,18})?', value, flags=re.ASCII):
                raise ValueError('Invalid public amount')
            result[key] = value
    for key in ['confirmedTransactions', 'totalTransactions']:
        value = data.get(key, 0 if key == 'confirmedTransactions' else 3)
        if type(value) is not int or not 0 <= value <= 3 or (key == 'totalTransactions' and value != 3):
            raise ValueError('Invalid count')
        result[key] = value
    result['complete'] = data.get('complete') is True
    if result['complete'] and (result['confirmedTransactions'] != 3 or result.get('stage') != 'complete' or result.get('errorCode')):
        raise ValueError('Contradictory completion state')
    if not result['complete'] and result.get('stage') == 'complete':
        raise ValueError('Contradictory completion stage')
    result['diagnosticOnly'] = True
    if 'totalFeeEstimateEth' in result:
        result['deploymentAndConnectionEstimateEth'] = including_deployment(result['totalFeeEstimateEth'])
    if 'totalActualFeeEth' in result:
        result['deploymentAndConnectionActualEth'] = including_deployment(result['totalActualFeeEth'])
    return result


PAGE = r'''<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Connect ORVIA GPU reports</title><style nonce="NONCE">body{font:18px system-ui;max-width:760px;margin:40px auto;padding:20px;background:#101014;color:#eee}input,button{font:inherit;padding:12px;margin:8px 0}input{width:90%}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#ccc}</style>
<h1>Connect GPU results to ORVIA</h1><p>Robinhood mainnet 4663 · the deployed 256-contract network</p>
<p>This registers the separately named phosphate diagnostic, opens its run, and records the completed GPU checks in up to three transactions. It is a retrospective numerical diagnostic, not an accepted scientific simulation. The signed report binds the reviewed input, result, software and environment files. The total estimate combines local execution measurements with a live quote; each real transaction is estimated again before submission.</p>
<p>Wallet: 0x2541a9e93B5C853E9208b0C5C7386dD458424c77<br>Coordinator: 0x3B188B4c5B76b009d80455D3bbB7597983E390f0</p>
<pre id="status">Checking the frozen connection plan…</pre>
<form id="form"><label>Encrypted wallet password<input id="password" type="password" autocomplete="off" required disabled></label><button id="unlock" disabled>Unlock &amp; connect GPU reports</button></form>
<button id="cancel">Cancel before unlock</button><p id="message"></p>
<script nonce="NONCE">const token=TOKEN;let busy=false;const status=document.querySelector('#status'),pass=document.querySelector('#password'),button=document.querySelector('#unlock'),msg=document.querySelector('#message');async function poll(){try{const r=await fetch('/status',{headers:{'X-ORVIA-CSRF':token},cache:'no-store'}),s=await r.json();const names={starting:'Checking reviewed files and preparing the local wallet',ready:'Ready for your local unlock',submitting:'Connecting GPU reports',complete:'GPU report connected and verified on chain',failed:'Stopped — preserved for review',cancelled:'Cancelled before unlock',expired:'Local unlock expired'};let text=names[s.state]||'Checking';if(s.quote){const q=s.quote;text+='\nConfirmed transactions: '+q.confirmedTransactions+' / '+q.totalTransactions+'\nRun: '+q.runId+'\nDiagnostic only: yes';if(q.totalFeeEstimateEth)text+='\nConditional total connection estimate: '+q.totalFeeEstimateEth+' ETH';if(q.feeReserveEth)text+='\nMaximum gas-limit funding at the preflight price: '+q.feeReserveEth+' ETH';if(q.totalActualFeeEth)text+='\nActual confirmed fee so far: '+q.totalActualFeeEth+' ETH';text+='\nDeployment already paid: 0.004612876889674 ETH';if(q.deploymentAndConnectionEstimateEth)text+='\nDeployment + full connection estimate: '+q.deploymentAndConnectionEstimateEth+' ETH';if(q.deploymentAndConnectionActualEth)text+='\nDeployment + confirmed connection fees: '+q.deploymentAndConnectionActualEth+' ETH';if(q.stage)text+='\nStage: '+q.stage;}text+='\nNew transactions use current market fees plus a 25% inclusion margin; no historical fee cap.';if(s.errorCode)text+='\nStop reason: '+s.errorCode;status.textContent=text;pass.disabled=button.disabled=!s.ready||busy;document.querySelector('#cancel').disabled=s.passwordSubmitted;if(s.passwordSubmitted)msg.textContent='Password submitted once and cleared. It remains on this computer; the GPU never receives it.';}catch{pass.disabled=button.disabled=true;msg.textContent='Local status unavailable. Do not start a duplicate connection.';}}document.querySelector('#form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;button.disabled=pass.disabled=true;let password=pass.value;pass.value='';try{const r=await fetch('/unlock',{method:'POST',headers:{'Content-Type':'application/json','X-ORVIA-CSRF':token},body:JSON.stringify({password})});password='';msg.textContent=r.ok?'Local unlock submitted.':'Unlock refused; review local status.';}catch{password='';msg.textContent='Local request failed; do not retry automatically.';}await poll();};document.querySelector('#cancel').onclick=async()=>{await fetch('/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-ORVIA-CSRF':token},body:'{}'});await poll();};poll();setInterval(poll,1000);</script>'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    manifest = verify_manifest(args.manifest, args.sha256)
    base_path = Path(__file__).resolve().parents[1] / 'deployment/local_unlock_market.py'
    if digest(read_checked(base_path)) != BASE_SHA:
        raise ValueError('Reviewed bridge dependency changed')
    spec = importlib.util.spec_from_file_location('reviewed_unlock_bridge', base_path)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    base.PAGE = PAGE
    base.ERROR_PHRASES[b'GPU connection stopped'] = 'connection_stopped'

    class ConnectionSession(base.Session):
        def status(self):
            result = super().status()
            result.update(transactions=3, planSha256=manifest['planSha256'])
            if result['state'] == 'complete' and not (result['quote'] and result['quote']['complete']):
                result['state'] = 'failed'
            return result

    progress = Path(manifest['progressFile'])
    public_progress(progress, manifest)
    command = [manifest['node']['path'], manifest['entrypoint'], 'connect', '--plan', manifest['planFile'],
               '--plan-sha', manifest['planSha256'], '--output', str(progress)]
    session = ConnectionSession(command, quote_reader=lambda: public_progress(progress, manifest))
    server, url, _ = base.make_server(session)
    print(url, flush=True)

    def stop(signum, frame):
        if session.used and session.state not in ['complete', 'failed']:
            return
        session.cancel()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        if not session.used:
            session.cancel()
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('GPU connection bridge stopped; no private details were logged.', flush=True)
        raise SystemExit(2)
