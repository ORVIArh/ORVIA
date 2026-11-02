#!/usr/bin/env python3
"""Synthetic PTY/HTTP security tests. Never opens a real wallet or launcher."""
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout,redirect_stderr

spec=importlib.util.spec_from_file_location('local_unlock',Path(__file__).with_name('local_unlock.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
QUOTE={'totalInfrastructureFeeEth':'0.002','totalInfrastructureFeeWei':'2000000000000000','totalInfrastructureGasIncludingL1Data':'230000000','gasPriceWei':'20000000','observedAtUtc':'2026-11-02T00:00:00Z','confirmedTransactions':0,'journalEntries':0,'completed':False}

def child(mode='raw',prompt=b.PROMPT,delay=0):
    setup="import tty;tty.setraw(0)" if mode=='raw' else ("import termios;t=termios.tcgetattr(0);t[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,t)" if mode=='canonical' else 'pass')
    return [sys.executable,'-c',f"import os,time,sys;{setup};os.write(1,{prompt!r});p=b''\nwhile not p.endswith(b'\\r') and not p.endswith(b'\\n'):\n p+=os.read(0,1)\ntime.sleep({delay});os.write(1,b'NEVER_LOG_PASSWORD:'+p);sys.exit(0 if p.strip()==b'synthetic secret' else 2)"]

def wait(predicate,seconds=3):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if predicate():return
        time.sleep(.02)
    raise AssertionError('Synthetic child timed out')

class BridgeTests(unittest.TestCase):
    def session(self,**kwargs):
        s=b.Session(child(kwargs.pop('mode','raw'),kwargs.pop('prompt',b.PROMPT),kwargs.pop('delay',0)),quote_reader=kwargs.pop('quote_reader',lambda:QUOTE),**kwargs)
        self.addCleanup(self.cleanup_session,s);return s
    @staticmethod
    def cleanup_session(s):
        if not s.used:s.cancel()
        s.thread.join(3)
    def server(self,s):
        server,url,token=b.make_server(s);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return server,token
    def request(self,server,token,method='POST',path='/unlock',body=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
        h={'Host':server.expected_host,'Origin':server.origin,'X-ORVIA-CSRF':token,'Content-Type':'application/json'}
        if headers:h.update(headers)
        encoded=json.dumps({'password':'synthetic secret'} if body is None else body)
        c.request(method,path,body=encoded if method=='POST' else None,headers=h);r=c.getresponse();data=r.read();c.close();return r.status,data
    def test_exact_raw_prompt_one_shot_and_no_output_leak(self):
        output=io.StringIO()
        with redirect_stdout(output),redirect_stderr(output):
            s=self.session();wait(lambda:s.status()['ready']);self.assertTrue(s.unlock('synthetic secret'));self.assertFalse(s.unlock('synthetic secret'));wait(lambda:s.state=='complete')
        self.assertNotIn('synthetic secret',output.getvalue());self.assertNotIn('NEVER_LOG_PASSWORD',output.getvalue());self.assertEqual(s.exit_code,0)
    def test_echo_and_canonical_modes_are_never_ready(self):
        for mode in ['echo','canonical']:
            s=self.session(mode=mode);time.sleep(.12);self.assertFalse(s.status()['ready']);self.assertFalse(s.unlock('synthetic secret'));s.cancel()
    def test_wrong_prompt_and_quote_missing_fail_closed(self):
        s=self.session(prompt=b'password: ');time.sleep(.12);self.assertFalse(s.unlock('synthetic secret'));s.cancel()
        s=self.session(quote_reader=lambda:None);wait(lambda:s.state=='ready');self.assertFalse(s.status()['ready']);self.assertFalse(s.unlock('synthetic secret'))
    def test_password_controls_rejected_before_use(self):
        s=self.session();wait(lambda:s.status()['ready'])
        for p in ['', 'a\nb','a\rb','a\x00b','a\x1bb','a\x80b','x'*1025]:self.assertFalse(s.unlock(p));self.assertFalse(s.used)
        self.assertTrue(s.unlock('synthetic secret'));wait(lambda:s.state=='complete')
    def test_expiration_and_preunlock_cancel_kill_child(self):
        s=self.session(lifetime=.12);wait(lambda:s.state=='expired');self.assertFalse(s.unlock('synthetic secret'));s.thread.join(2);self.assertFalse(s.thread.is_alive())
        s=self.session();wait(lambda:s.status()['ready']);self.assertTrue(s.cancel());s.thread.join(2);self.assertEqual(s.state,'cancelled');self.assertFalse(s.thread.is_alive())
    def test_after_unlock_cancel_does_not_interrupt(self):
        s=self.session(delay=.3);wait(lambda:s.status()['ready']);self.assertTrue(s.unlock('synthetic secret'));self.assertFalse(s.cancel());wait(lambda:s.state=='complete');self.assertEqual(s.exit_code,0)
    def test_late_prompt_cannot_resurrect_cancel_or_expiry(self):
        code="import signal,time,tty,os;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(.25);tty.setraw(0);os.write(1,"+repr(b.PROMPT)+");time.sleep(2)"
        for expired in [False,True]:
            s=b.Session([sys.executable,'-c',code],quote_reader=lambda:QUOTE,lifetime=.1 if expired else 5)
            self.addCleanup(self.cleanup_session,s);time.sleep(.07)
            if not expired:self.assertTrue(s.cancel())
            time.sleep(.3);self.assertEqual(s.state,'expired' if expired else 'cancelled');self.assertFalse(s.unlock('synthetic secret'));s.thread.join(2)
    def test_partial_password_write_stops_child(self):
        s=self.session();wait(lambda:s.status()['ready'])
        with patch.object(b.os,'write',return_value=1):self.assertFalse(s.unlock('synthetic secret'))
        s.thread.join(2);self.assertFalse(s.thread.is_alive());self.assertEqual(s.state,'failed');self.assertTrue(s.used)
    def test_inherited_code_injection_environment_is_removed(self):
        code="import os,sys;sys.exit(0 if not any(k in os.environ for k in ['NODE_OPTIONS','PYTHONPATH','DYLD_INSERT_LIBRARIES','ZDOTDIR','ENV']) else 2)"
        with patch.dict(b.os.environ,{'NODE_OPTIONS':'injected','PYTHONPATH':'injected','DYLD_INSERT_LIBRARIES':'injected','ZDOTDIR':'injected','ENV':'injected'}):
            s=b.Session([sys.executable,'-c',code],quote_reader=lambda:QUOTE);self.addCleanup(self.cleanup_session,s)
        s.thread.join(2);self.assertEqual(s.exit_code,0)
    def test_fixed_error_code_without_raw_output(self):
        code="import os,tty;tty.setraw(0);os.write(1,"+repr(b.PROMPT)+");p=b''\nwhile not p.endswith(b'\\r'):p+=os.read(0,1)\nos.write(1,b'RPC failed during eth_getTransactionReceipt; no automatic transaction replacement. '+p);raise SystemExit(2)"
        output=io.StringIO()
        with redirect_stdout(output),redirect_stderr(output):
            s=b.Session([sys.executable,'-c',code],quote_reader=lambda:QUOTE);self.addCleanup(self.cleanup_session,s);wait(lambda:s.status()['ready']);self.assertTrue(s.unlock('synthetic secret'));wait(lambda:s.state=='failed')
        self.assertEqual(s.status()['errorCode'],'receipt_read_failed');self.assertNotIn('synthetic secret',json.dumps(s.status()));self.assertEqual(output.getvalue(),'')
    def test_http_host_origin_csrf_and_type_guards(self):
        s=self.session();wait(lambda:s.status()['ready']);server,token=self.server(s)
        for headers in [{'Host':'evil.test'},{'Origin':'http://evil.test'},{'X-ORVIA-CSRF':'bad'},{'Content-Type':'text/plain'},{'Transfer-Encoding':'chunked'}]:
            self.assertEqual(self.request(server,token,headers=headers)[0],403);self.assertFalse(s.used)
        self.assertEqual(self.request(server,token,body={'password':'synthetic secret','extra':1})[0],409);self.assertFalse(s.used)
        code,data=self.request(server,token,method='GET',path='/status');self.assertEqual(code,200);self.assertNotIn(b'synthetic secret',data)
        self.assertEqual(self.request(server,token)[0],200);self.assertEqual(self.request(server,token)[0],409);wait(lambda:s.state=='complete')
    def test_page_is_capability_protected_and_csp_bound(self):
        s=self.session();server,token=self.server(s)
        self.assertEqual(self.request(server,token,method='GET',path='/')[0],403)
        code,page=self.request(server,token,method='GET',path='/'+token);self.assertEqual(code,200);self.assertIn(b'Unlock &amp; deploy 256 contracts',page)
        self.assertNotIn(b'<iframe',page);self.assertEqual(server.server_address[0],'127.0.0.1')

if __name__=='__main__':unittest.main(verbosity=2)
