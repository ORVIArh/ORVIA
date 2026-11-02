#!/usr/bin/env python3
"""One-use loopback password bridge to the separately frozen deployment launcher.

Never records PTY output or password. Only the browser's explicit submit supplies
one password to an already active raw/no-echo prompt. No wallet logic lives here.
"""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pwd
import pty
import secrets
import select
import signal
import stat
import subprocess
import sys
import termios
import threading
import time

LAUNCHER_SHA='93dd1b963879136d2690d901a081727072878e2e53c449582a78d77738e0d7d6'
PLAN_SHA='814e9c0aced4f8c6ef24bf4ca7fe5d423ef8bb4e4d54216a3dea02484958b50c'
OPERATOR='0x2541a9e93B5C853E9208b0C5C7386dD458424c77'
PROMPT=b'Local encrypted-wallet password (hidden): '
RECOVERY_HELPER_SHA='5169b939ff323645b9396ae98823012be55116f1c945af042e961c3f735a178e'
MAX_BODY=16384
ERROR_PHRASES={
    b'RPC failed during eth_getTransactionReceipt;':'receipt_read_failed',
    b'RPC failed during eth_getBlockByNumber;':'block_read_failed',
    b'RPC failed during eth_getCode;':'runtime_read_failed',
    b'RPC failed during eth_call;':'contract_read_failed',
    b'RPC failed during eth_getTransactionCount;':'nonce_read_failed',
    b'RPC failed during eth_getBalance;':'balance_read_failed',
    b'RPC failed during eth_gasPrice;':'gas_price_read_failed',
    b'RPC failed during eth_estimateGas;':'estimate_failed',
    b'RPC failed during eth_sendRawTransaction;':'broadcast_outcome_unknown',
    b'Confirmation timed out.':'receipt_confirmation_timeout',
    b'Receipt is no longer in the canonical chain.':'receipt_reorg',
    b'Transaction failed or returned an invalid receipt.':'receipt_failed',
    b'Deployment stopped. Preserve the journal for inspection.':'unclassified_deployment_failure',
}


def public_journal():
    """Return only bounded public quote/progress fields, never signed entries."""
    home=Path(pwd.getpwuid(os.getuid()).pw_dir)
    target=home/'.orvia'/'deployments'/(PLAN_SHA+'.json')
    cursor=Path('/')
    for component in target.parent.parts[1:]:
        cursor/=component
        s=cursor.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_mode & 0o022:
            raise ValueError('Unsafe journal directory')
    fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1 or not 0<s.st_size<=4*1024*1024:
            raise ValueError('Unsafe journal')
        data=json.loads(os.read(fd,4*1024*1024+1))
    finally:os.close(fd)
    q=data.get('initialQuote',{})
    if data.get('planSha256')!=PLAN_SHA or q.get('planSha256')!=PLAN_SHA or q.get('chainId')!=4663 or q.get('sender','').lower()!=OPERATOR.lower() or q.get('actualContracts')!=256 or q.get('infrastructureTransactions')!=33:
        raise ValueError('Wrong deployment journal')
    out={key:q.get(key) for key in ['totalInfrastructureFeeEth','totalInfrastructureFeeWei','totalInfrastructureGasIncludingL1Data','gasPriceWei','observedAtUtc']}
    for key,value in out.items():
        if not isinstance(value,str) or not 0<len(value)<=80:raise ValueError('Invalid quote field')
    for key in ['totalInfrastructureFeeWei','totalInfrastructureGasIncludingL1Data','gasPriceWei']:
        if not out[key].isascii() or not out[key].isdigit():raise ValueError('Invalid quote quantity')
    entries=data.get('entries')
    if not isinstance(entries,list) or len(entries)>33:raise ValueError('Invalid deployment count')
    out.update(confirmedTransactions=sum(isinstance(e,dict) and isinstance(e.get('receipt'),dict) and e['receipt'].get('status') in ['0x1',1] for e in entries),journalEntries=len(entries),completed=data.get('completed') is True)
    return out


class Session:
    def __init__(self,command,quote_reader=public_journal,lifetime=900):
        self.lock=threading.RLock();self.created=time.monotonic();self.lifetime=lifetime
        self.state='starting';self.used=False;self.exit_code=None;self.quote_reader=quote_reader
        self.kill_started=False;self.error_code=None
        self.pid,self.master=pty.fork()
        if self.pid==0:
            try:os.execve(command[0],command,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':pwd.getpwuid(os.getuid()).pw_dir,'LANG':'C.UTF-8','TERM':'xterm-256color'})
            except BaseException:os._exit(127)
        self.thread=threading.Thread(target=self._watch,daemon=True);self.thread.start()
    def raw_prompt(self):
        try:
            flags=termios.tcgetattr(self.master)[3]
            return not(flags & (termios.ECHO|termios.ICANON))
        except (OSError,termios.error):return False
    def quote(self):
        try:return self.quote_reader()
        except Exception:return None
    def _watch(self):
        tail=bytearray()
        while True:
            with self.lock:
                if self.state in ['starting','ready'] and not self.used and time.monotonic()-self.created>=self.lifetime:
                    self._kill();self.state='expired'
            try:
                ready,_,_=select.select([self.master],[],[],.1)
                if ready:
                    chunk=os.read(self.master,4096)
                    if not chunk:break
                    with self.lock:
                        if not self.used:
                            tail.extend(chunk);del tail[:-4096]
                            if self.state=='starting' and PROMPT in tail and self.raw_prompt():self.state='ready'
                        else:
                            tail.extend(chunk);del tail[:-4096]
                            for phrase,code in ERROR_PHRASES.items():
                                if phrase in tail:self.error_code=code
            except (OSError,ValueError):break
            try:
                pid,status=os.waitpid(self.pid,os.WNOHANG)
                if pid:
                    self.exit_code=os.waitstatus_to_exitcode(status);break
            except ChildProcessError:break
        try:
            if self.exit_code is None:
                _,status=os.waitpid(self.pid,0);self.exit_code=os.waitstatus_to_exitcode(status)
        except ChildProcessError:pass
        with self.lock:
            if self.state not in ['cancelled','expired']:
                self.state='complete' if self.used and self.exit_code==0 else 'failed'
        tail.clear()
        try:os.close(self.master)
        except OSError:pass
    def _kill(self):
        if self.kill_started:return
        self.kill_started=True
        try:os.killpg(self.pid,signal.SIGTERM)
        except ProcessLookupError:return
        # The frozen command may be in a native call: enforce process-group stop.
        def later():
            time.sleep(.5)
            if self.exit_code is not None:return
            try:os.killpg(self.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        threading.Thread(target=later,daemon=True).start()
    def cancel(self):
        with self.lock:
            if self.used or self.state in ['cancelled','expired','complete','failed']:return False
            self.state='cancelled';self._kill();return True
    def unlock(self,password):
        with self.lock:
            if self.used or self.state!='ready' or time.monotonic()-self.created>=self.lifetime or not self.raw_prompt() or self.quote() is None:return False
            if not isinstance(password,str) or not 0<len(password.encode('utf8'))<=1024 or any(ord(c)<32 or 127<=ord(c)<=159 for c in password):return False
            self.used=True;self.state='submitting'
            payload=bytearray(password.encode('utf8')+b'\r')
            try:
                # Raw tty writes are bounded below PIPE_BUF; reject partial writes.
                if os.write(self.master,payload)!=len(payload):self.state='failed';self._kill();return False
            except OSError:self.state='failed';self._kill();return False
            finally:payload[:]=b'\0'*len(payload)
            return True
    def status(self):
        with self.lock:
            q=self.quote()
            return {'state':self.state,'ready':self.state=='ready' and not self.used and self.raw_prompt() and q is not None,'quote':q,'operator':OPERATOR,'chainId':4663,'contracts':256,'transactions':33,'planSha256':PLAN_SHA,'passwordSubmitted':self.used,'errorCode':self.error_code}


PAGE=r'''<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>ORVIA local deployment</title><style nonce="NONCE">body{font:18px system-ui;max-width:760px;margin:50px auto;padding:20px;background:#101014;color:#eee}input,button{font:inherit;padding:12px;margin:8px 0}input{width:90%}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#ccc}</style><h1>Deploy 256 ORVIA contracts</h1><p>Mainnet 4663 · 33 transactions · operator 0x2541a9e93B5C853E9208b0C5C7386dD458424c77</p><p>This deploys report infrastructure. It does not certify a molecular result. The password stays on this computer and is sent once to the frozen local wallet prompt. This continuation can replace only the saved fourth transaction, keeping the same contract operation. It then finishes the remaining deployment using current network fees plus a 25% inclusion margin. There is no historical fee cap.</p><pre id="status">Checking the frozen release and obtaining a quote…</pre><form id="form"><label>Encrypted wallet password<input id="password" type="password" autocomplete="off" required disabled></label><button id="unlock" disabled>Unlock &amp; deploy 256 contracts</button></form><button id="cancel">Cancel before unlock</button><p id="message"></p><script nonce="NONCE">const token=TOKEN;let busy=false;const msg=document.querySelector('#message'),status=document.querySelector('#status'),pass=document.querySelector('#password'),button=document.querySelector('#unlock');async function poll(){try{const r=await fetch('/status',{headers:{'X-ORVIA-CSRF':token},cache:'no-store'});const s=await r.json();const names={starting:'Checking release and preparing the local wallet prompt',ready:'Ready for your password',submitting:'Deploying — keep this page open',complete:'All 256 contracts deployed and verified',failed:'Stopped — preserve the local journal for review',cancelled:'Cancelled before unlock',expired:'Unlock page expired'};let text=names[s.state]||'Checking status';if(s.quote){const q=s.quote;button.textContent=q.confirmedTransactions?'Unlock & finish deployment ('+(33-q.confirmedTransactions)+' transactions remain)':'Unlock & deploy 256 contracts';const eth=w=>{const n=BigInt(w),a=n/1000000000000000000n,b=(n%1000000000000000000n).toString().padStart(18,'0').replace(/0+$/,'');return a.toString()+(b?'.'+b:'');};if(s.errorCode)text+='\nStop reason: '+s.errorCode;text+='\nConfirmed transactions: '+q.confirmedTransactions+' / 33\nHistorical original estimate: '+q.totalInfrastructureFeeEth+' ETH\nHistorical quote time: '+q.observedAtUtc+'\nLive fee policy: current market quote + 25% inclusion margin. No historical fee cap.\nActual spend depends on live fees and available wallet balance.';if(q.marketEstimateWei)text+='\nIndicative full infrastructure total at preflight (includes already paid): '+eth(q.marketEstimateWei)+' ETH';}status.textContent=text;pass.disabled=button.disabled=!s.ready||busy;document.querySelector('#cancel').disabled=s.passwordSubmitted;if(s.passwordSubmitted)msg.textContent='Password submitted once. Keep this page open while the 33 transactions finish. Closing the page does not cancel an unlocked deployment.';}catch{msg.textContent='Local status unavailable. Preserve the deployment journal; do not start a duplicate.';pass.disabled=button.disabled=true;}}document.querySelector('#form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;button.disabled=pass.disabled=true;let password=pass.value;pass.value='';try{const r=await fetch('/unlock',{method:'POST',headers:{'Content-Type':'application/json','X-ORVIA-CSRF':token},body:JSON.stringify({password})});password='';msg.textContent=r.ok?'Password handed to the local prompt. Deployment is proceeding.':'Unlock was refused. No automatic retry; inspect local status.';}catch{password='';msg.textContent='Local request failed. Do not retry automatically; inspect status.';}await poll();};document.querySelector('#cancel').onclick=async()=>{await fetch('/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-ORVIA-CSRF':token},body:'{}'});await poll();};poll();setInterval(poll,1000);</script>'''


def make_server(session):
    csrf=secrets.token_urlsafe(32);nonce=secrets.token_urlsafe(24)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,code,value,html=False):
            body=value.encode() if html else json.dumps(value,separators=(',',':')).encode()
            self.send_response(code);self.send_header('Content-Type','text/html; charset=utf-8' if html else 'application/json');self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers();self.wfile.write(body)
        def host_ok(self):return self.headers.get_all('Host',[])==[self.server.expected_host]
        def authenticated(self):
            supplied=self.headers.get_all('X-ORVIA-CSRF',[])
            return self.host_ok() and len(supplied)==1 and supplied[0].isascii() and hmac.compare_digest(supplied[0],csrf)
        def do_GET(self):
            if not self.host_ok():return self.reply(403,{'error':'Refused'})
            if self.path=='/'+csrf:return self.reply(200,PAGE.replace('NONCE',nonce).replace('TOKEN',json.dumps(csrf)),True)
            if self.path=='/status' and self.authenticated():return self.reply(200,session.status())
            self.reply(403,{'error':'Refused'})
        def do_POST(self):
            if not self.authenticated() or self.headers.get_all('Origin',[])!=[self.server.origin] or self.headers.get_all('Content-Type',[])!=['application/json'] or self.headers.get('Transfer-Encoding') is not None:return self.reply(403,{'error':'Refused'})
            lengths=self.headers.get_all('Content-Length',[])
            if len(lengths)!=1 or len(lengths[0])>5 or not lengths[0].isascii() or not lengths[0].isdigit() or not 1<=int(lengths[0])<=MAX_BODY:return self.reply(400,{'error':'Refused'})
            self.connection.settimeout(3)
            try:
                body=self.rfile.read(int(lengths[0]));data=json.loads(body)
                if len(body)!=int(lengths[0]) or not isinstance(data,dict):raise ValueError()
                if self.path=='/unlock' and set(data)=={'password'}:ok=session.unlock(data['password'])
                elif self.path=='/cancel' and data=={}:ok=session.cancel()
                else:ok=False
            except Exception:ok=False
            # No request body, exception, password or PTY output is logged.
            self.reply(200 if ok else 409,{'accepted':ok})
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
    server.expected_host='127.0.0.1:'+str(server.server_port);server.origin='http://'+server.expected_host
    return server,server.origin+'/'+csrf,csrf


def main():
    market_estimate=None
    launcher=Path(__file__).resolve().parents[3]/'output'/'hybrid256-release-market'/'Deploy256.command'
    s=launcher.lstat()
    if not stat.S_ISREG(s.st_mode) or launcher.is_symlink() or hashlib.sha256(launcher.read_bytes()).hexdigest()!=LAUNCHER_SHA:raise ValueError('Frozen launcher mismatch')
    journal=Path(pwd.getpwuid(os.getuid()).pw_dir)/'.orvia'/'deployments'/(PLAN_SHA+'.json')
    resume=sys.argv[1:]==['--resume-confirmed']
    if sys.argv[1:] and not resume:raise ValueError('Invalid option')
    if journal.exists() and public_journal()['journalEntries']:
        if not resume:raise ValueError('Existing signed deployment requires separately reviewed journal recovery')
        environment={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':pwd.getpwuid(os.getuid()).pw_dir,'LANG':'C.UTF-8'}
        checked=subprocess.run(['/bin/zsh','-f',str(launcher),'--verify-only'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60,env=environment)
        if checked.returncode:raise ValueError('Frozen release verification failed')
        manifest=json.loads((launcher.parent/'manifest.json').read_text())
        helper=Path(__file__).with_name('verify_market_recovery.mjs')
        if helper.is_symlink() or hashlib.sha256(helper.read_bytes()).hexdigest()!=RECOVERY_HELPER_SHA:raise ValueError('Recovery helper changed')
        gate=subprocess.run([manifest['node']['path'],str(helper),str(launcher.parent)],capture_output=True,timeout=180,env=environment)
        if gate.returncode:raise ValueError('Confirmed recovery gate failed')
        proof=json.loads(gate.stdout)
        if proof.get('recoveryVerified') is not True or proof.get('planSha256')!=PLAN_SHA or proof.get('publicTransactionsSent')!=0 or hashlib.sha256(journal.read_bytes()).hexdigest()!=proof.get('journalSha256'):raise ValueError('Recovery journal changed')
        market_estimate=proof.get('indicativeFullInfrastructureFeeWei')
        if not isinstance(market_estimate,str) or not market_estimate.isascii() or not market_estimate.isdigit():raise ValueError('Invalid market estimate')
    elif resume:raise ValueError('No confirmed journal to resume')
    def market_quote():
        quote=public_journal()
        if market_estimate is not None:quote['marketEstimateWei']=market_estimate
        return quote
    session=Session(['/bin/zsh','-f',str(launcher)],quote_reader=market_quote);server,url,_=make_server(session)
    print(url,flush=True)
    def stop(signum,frame):
        if session.used and session.state not in ['complete','failed']:return
        session.cancel();threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
    try:server.serve_forever(poll_interval=.2)
    finally:
        if not session.used:session.cancel()
        server.server_close()

if __name__=='__main__':
    try:main()
    except Exception:print('Local deployment bridge stopped; no error details are logged.',flush=True);raise SystemExit(2)
