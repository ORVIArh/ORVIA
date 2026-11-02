#!/usr/bin/env python3
"""Synthetic PTY integration checks. No real wallet or HOME override is used."""
import json
import os
from pathlib import Path
import pty
import pwd
import select
import shutil
import signal
import subprocess
import tempfile
import termios
import time
import tty


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
NODE = shutil.which("node")
assert NODE, "Node is required"
SCRIPT = HERE / "local_wallet.mjs"

# Only this subprocess manufactures synthetic fixtures. Captured values stay in
# this test process; they are never included in arguments, environment or logs.
fixture = json.loads(subprocess.check_output([
    NODE, "--input-type=module", "-e",
    "import { Wallet } from 'ethers'; import { randomBytes } from 'node:crypto';"
    "const a=new Wallet('0x'+randomBytes(32).toString('hex'));"
    "const b=new Wallet('0x'+randomBytes(32).toString('hex'));"
    "process.stdout.write(JSON.stringify({key:a.privateKey,address:a.address,wrongKey:b.privateKey}));",
], cwd=ROOT))
password = "Synthetic unique passphrase é 987654"
TYPEAHEAD = "synthetic-typeahead-must-never-echo"
ACTIVE = []

DRIVER = r"""
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const [script, home, command, address] = process.argv.slice(1);
process.argv[1] = 'synthetic-wallet-test-driver';
const actualUser = os.userInfo();
os.userInfo = () => ({ ...actualUser, homedir: home });
const { main, SafeError } = await import(pathToFileURL(script));
try {
  await main([command, '--address', address]);
  process.exit(0);
} catch(error) {
  process.stderr.write((error instanceof SafeError ? error.message : 'Unexpected safe test failure.')+'\n');
  process.exit(1);
}
"""


class Session:
    def __init__(self, home, command="import"):
        self.master, self.slave = pty.openpty()
        self.original = termios.tcgetattr(self.slave)
        self.output = b""
        self.proc = subprocess.Popen([
            NODE, "--input-type=module", "-e", DRIVER,
            str(SCRIPT), str(home), command, fixture["address"],
        ], cwd=ROOT, stdin=self.slave, stdout=self.slave,
           stderr=self.slave, start_new_session=True)
        ACTIVE.append(self)

    def until(self, marker, timeout=15):
        deadline = time.monotonic() + timeout
        encoded = marker.encode()
        while encoded not in self.output:
            assert time.monotonic() < deadline, "Timed out waiting for expected wallet prompt"
            ready, _, _ = select.select([self.master], [], [], 0.1)
            if ready:
                chunk = os.read(self.master, 65536)
                assert chunk, "Child closed before expected prompt"
                self.output += chunk
            elif self.proc.poll() is not None:
                saved = b"Encrypted wallet saved:" in self.output
                raise AssertionError(f"Child exited before expected prompt (status={self.proc.returncode}, saved={saved})")

    def send(self, value):
        os.write(self.master, value.encode() if isinstance(value, str) else value)

    def finish(self, status, timeout=20):
        deadline = time.monotonic() + timeout
        while self.proc.poll() is None:
            assert time.monotonic() < deadline, "Wallet child did not exit"
            ready, _, _ = select.select([self.master], [], [], 0.1)
            if ready:
                self.output += os.read(self.master, 65536)
        while select.select([self.master], [], [], 0)[0]:
            self.output += os.read(self.master, 65536)
        assert self.proc.returncode == status, "Unexpected wallet child exit status"
        current = termios.tcgetattr(self.slave)
        mask = termios.ECHO | termios.ICANON | termios.ISIG
        assert current[3] & mask == self.original[3] & mask, "Terminal mode was not restored"
        for value in (fixture["key"], fixture["wrongKey"], password, TYPEAHEAD):
            assert value.encode() not in self.output, "A synthetic secret was echoed"
        # After checking restoration, expose any kernel input queue for this test
        # only. A shell must not inherit password/typeahead bytes on child exit.
        tty.setraw(self.slave, termios.TCSANOW)
        os.set_blocking(self.slave, False)
        try:
            remaining = os.read(self.slave, 65536)
        except BlockingIOError:
            remaining = b""
        assert not remaining, "Terminal input queue was not flushed"
        os.close(self.master)
        os.close(self.slave)
        ACTIVE.remove(self)


def new_home(parent, name):
    home = parent / name
    home.mkdir(mode=0o700)
    return home


def run():
    passed = 0
    account_home = pwd.getpwuid(os.getuid()).pw_dir
    with tempfile.TemporaryDirectory(prefix=".orvia-wallet-tty-test-", dir=account_home) as tmp:
        parent = Path(tmp)
        os.chmod(parent, 0o700)

        home = new_home(parent, "success")
        session = Session(home)
        session.until("Private key (local input only): ")
        assert not termios.tcgetattr(session.slave)[3] & termios.ECHO, "Secret input has terminal echo enabled"
        session.send(fixture["key"] + "\r")
        session.until("New password (at least 16 characters): ")
        # UTF-8 and backspace exercise genuine terminal input handling.
        session.send(password + "Z\x7f\r")
        session.until("Confirm password: ")
        session.send(password + "\r")
        session.until("Encrypting and checking recovery...")
        session.send(TYPEAHEAD + "\r")
        session.until("Encrypted wallet saved:")
        session.finish(0)
        stored = home / ".orvia" / "keystores" / "report-signer.json"
        assert stored.stat().st_mode & 0o777 == 0o600
        assert fixture["key"][2:] not in stored.read_text()
        assert password not in stored.read_text()
        passed += 1

        original_ciphertext = stored.read_bytes()
        session = Session(home)
        session.until("A wallet file already exists.")
        session.finish(1)
        assert stored.read_bytes() == original_ciphertext
        passed += 1

        session = Session(home, "unlock-check")
        session.until("Wallet password (local input only): ")
        session.send(password + "\r")
        session.until("Wallet unlock verified:")
        session.finish(0)
        passed += 1

        session = Session(home, "unlock-check")
        session.until("Wallet password (local input only): ")
        session.send("Wrong synthetic password 123456\r")
        session.until("Wallet could not be unlocked.")
        session.finish(1)
        passed += 1

        wrong_home = new_home(parent, "wrong-key")
        session = Session(wrong_home)
        session.until("Private key (local input only): ")
        session.send(fixture["wrongKey"] + "\r")
        session.until("does not match the expected public wallet")
        session.finish(1)
        assert not (wrong_home / ".orvia" / "keystores" / "report-signer.json").exists()
        passed += 1

        mismatch_home = new_home(parent, "password-mismatch")
        session = Session(mismatch_home)
        session.until("Private key (local input only): ")
        session.send(fixture["key"] + "\r")
        session.until("New password (at least 16 characters): ")
        session.send(password + "\r")
        session.until("Confirm password: ")
        session.send(password + "different\r")
        session.until("Passwords did not match.")
        session.finish(1)
        assert not (mismatch_home / ".orvia" / "keystores" / "report-signer.json").exists()
        passed += 1

        for name, data, message, status in [
            ("ctrl-c", b"\x03", "Cancelled.", 130),
            ("ctrl-d", b"\x04", "Cancelled.", 130),
            ("multiline", (fixture["key"] + "\nsecond-line\n").encode(), "multiline input was rejected", 1),
            ("escape", b"\x1b[200~synthetic-input", "Unsupported control character", 1),
            ("oversize", b"a" * 67, "Input is too long", 1),
        ]:
            session = Session(new_home(parent, name))
            session.until("Private key (local input only): ")
            session.send(data)
            session.until(message)
            session.finish(status)
            passed += 1

        session = Session(new_home(parent, "sigterm"))
        session.until("Private key (local input only): ")
        session.proc.send_signal(signal.SIGTERM)
        session.until("Cancelled.")
        session.finish(130)
        passed += 1

        cancelled_home = new_home(parent, "cancel-during-encryption")
        session = Session(cancelled_home)
        session.until("Private key (local input only): ")
        session.send(fixture["key"] + "\r")
        session.until("New password (at least 16 characters): ")
        session.send(password + "\r")
        session.until("Confirm password: ")
        session.send(password + "\r")
        session.until("Encrypting and checking recovery...")
        session.send(b"\x03")
        session.until("Cancelled.")
        session.finish(130)
        assert not (cancelled_home / ".orvia" / "keystores" / "report-signer.json").exists()
        passed += 1

    print(f"PASS: {passed} synthetic PTY scenarios; hidden input and terminal restoration verified.")


if __name__ == "__main__":
    try:
        run()
    finally:
        for session in ACTIVE:
            session.proc.kill()
            session.proc.wait()
            os.close(session.master)
            os.close(session.slave)
