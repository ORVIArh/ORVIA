// Synthetic-only security checks. Never read or write the user's real keystore.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import {
  SafeError, secureDirectory, validateKeystore, privateAccount, checkPassword,
  encryptVerified, decryptVerified, saveExclusive, readPrivateFile,
} from './local_wallet.mjs';

const home = os.userInfo().homedir;
const temporary = fs.mkdtempSync(path.join(home, '.orvia-wallet-test-'));
fs.chmodSync(temporary, 0o700);
const wallet = new Wallet('0x' + randomBytes(32).toString('hex'));
const other = new Wallet('0x' + randomBytes(32).toString('hex'));
const password = randomBytes(24).toString('base64url');
let encrypted;
before(async () => { encrypted = await encryptVerified(wallet, password); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

test('encryption is recoverable, uses the bounded V3 profile, and stores no plaintext secrets', async () => {
  const data = validateKeystore(encrypted, wallet.address);
  assert.equal(data.version, 3);
  assert.deepEqual({ n: data.Crypto.kdfparams.n, r: data.Crypto.kdfparams.r,
    p: data.Crypto.kdfparams.p, dklen: data.Crypto.kdfparams.dklen },
    { n: 131072, r: 8, p: 1, dklen: 32 });
  assert(!encrypted.includes(wallet.privateKey.slice(2)));
  assert(!encrypted.includes(password));
  const recovered = await decryptVerified(encrypted, password, wallet.address);
  assert.equal(recovered.address, wallet.address);
  assert.equal(recovered.privateKey, wallet.privateKey);
  assert.equal(recovered.provider, null);
});

test('every encryption uses fresh salt, IV and ciphertext', async () => {
  const first = JSON.parse(encrypted);
  const second = JSON.parse(await encryptVerified(wallet, password));
  assert.notEqual(first.Crypto.kdfparams.salt, second.Crypto.kdfparams.salt);
  assert.notEqual(first.Crypto.cipherparams.iv, second.Crypto.cipherparams.iv);
  assert.notEqual(first.Crypto.ciphertext, second.Crypto.ciphertext);
});

test('wrong password and altered ciphertext fail with a secret-safe message', async () => {
  const corrupt = JSON.parse(encrypted);
  corrupt.Crypto.ciphertext = (corrupt.Crypto.ciphertext[0] === '0' ? '1' : '0') + corrupt.Crypto.ciphertext.slice(1);
  for (const [json, pass] of [[encrypted, password + '-wrong'], [JSON.stringify(corrupt), password]]) {
    await assert.rejects(decryptVerified(json, pass, wallet.address), error => {
      assert(error instanceof SafeError);
      assert(!error.message.includes(password));
      assert(!error.message.includes(wallet.privateKey));
      assert.equal(error.message, 'Wallet could not be unlocked. Check the password and wallet file.');
      return true;
    });
  }
});

test('private key must derive the exact expected address and invalid scalars stay secret', () => {
  assert.equal(privateAccount(wallet.privateKey, wallet.address).address, wallet.address);
  assert.equal(privateAccount(wallet.privateKey.slice(2), wallet.address).address, wallet.address);
  assert.throws(() => privateAccount(wallet.privateKey, other.address), SafeError);
  for (const key of ['0'.repeat(64), 'f'.repeat(64), 'synthetic invalid input example', wallet.privateKey + '0']) {
    assert.throws(() => privateAccount(key, wallet.address), error => {
      assert(error instanceof SafeError);
      assert(!error.message.includes(key));
      return true;
    });
  }
});

test('keystore address mismatch and manipulated recorded address cannot unlock', async () => {
  assert.throws(() => validateKeystore(encrypted, other.address), SafeError);
  const relabelled = JSON.parse(encrypted);
  relabelled.address = other.address.slice(2).toLowerCase();
  await assert.rejects(decryptVerified(JSON.stringify(relabelled), password, other.address), SafeError);
});

test('malformed and resource-amplifying keystores are rejected before decryption', () => {
  const mutations = [
    d => { d.version = 1; },
    d => { d.Crypto.kdfparams.n = 1073741824; },
    d => { d.Crypto.kdfparams.n = 1024; },
    d => { d.Crypto.kdfparams.r = 1024; },
    d => { d.Crypto.kdfparams.p = 1024; },
    d => { d.Crypto.kdfparams.dklen = 64; },
    d => { d.Crypto.kdfparams.n = '131072'; },
    d => { d.Crypto.kdf = 'pbkdf2'; },
    d => { d.Crypto.cipher = 'aes-256-cbc'; },
    d => { d.Crypto.cipherparams.iv = '00'; },
    d => { d.Crypto.kdfparams.salt = '00'; },
    d => { d.Crypto.mac = '00'; },
    d => { d.Crypto.ciphertext = '00'; },
    d => { d.crypto = d.Crypto; },
    d => { d['x-ethers'] = { version: '0.1' }; },
  ];
  for (const mutate of mutations) {
    const data = JSON.parse(encrypted);
    mutate(data);
    assert.throws(() => validateKeystore(JSON.stringify(data), wallet.address), SafeError);
  }
  for (const json of ['null', '[]', '{', encrypted + ' '.repeat(8192)]) {
    assert.throws(() => validateKeystore(json, wallet.address), SafeError);
  }
});

test('password confirmation is exact and normalized short passwords are refused', () => {
  assert.doesNotThrow(() => checkPassword(password, password));
  assert.throws(() => checkPassword(password, password + ' '), SafeError);
  assert.throws(() => checkPassword('short', 'short'), SafeError);
  assert.throws(() => checkPassword('a'.repeat(1025), 'a'.repeat(1025)), SafeError);
  assert.doesNotThrow(() => checkPassword('  long enough passphrase  ', '  long enough passphrase  '));
});

test('private directories are created 0700 and unsafe existing directories or symlinks fail', () => {
  const good = path.join(temporary, 'safe', 'keystores');
  secureDirectory(home, good, true);
  assert.equal(fs.statSync(good).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(good)).mode & 0o777, 0o700);
  const unsafe = path.join(temporary, 'unsafe');
  fs.mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => secureDirectory(home, unsafe), SafeError);
  const link = path.join(temporary, 'link');
  fs.symlinkSync(good, link);
  assert.throws(() => secureDirectory(home, link), SafeError);
  assert.throws(() => secureDirectory(home, '/tmp/orvia-must-not-create'), SafeError);
});

test('exclusive save writes ciphertext only with 0600 and refuses overwrite and symlink targets', () => {
  const file = path.join(temporary, 'wallet.json');
  saveExclusive(file, encrypted, wallet.address);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readPrivateFile(file), encrypted + '\n');
  assert.throws(() => saveExclusive(file, encrypted, wallet.address), SafeError);
  assert.equal(fs.readFileSync(file, 'utf8'), encrypted + '\n');
  const link = path.join(temporary, 'wallet-link.json');
  fs.symlinkSync(file, link);
  assert.throws(() => saveExclusive(link, encrypted, wallet.address), SafeError);
  assert.throws(() => readPrivateFile(link), SafeError);
});

test('reader refuses public files, hard links, directories, empty and oversized input', () => {
  const file = path.join(temporary, 'reader.json');
  fs.writeFileSync(file, encrypted, { mode: 0o644 });
  assert.throws(() => readPrivateFile(file), SafeError);
  fs.chmodSync(file, 0o600);
  const hardlink = path.join(temporary, 'hardlink.json');
  fs.linkSync(file, hardlink);
  assert.throws(() => readPrivateFile(file), SafeError);
  fs.unlinkSync(hardlink);
  fs.writeFileSync(file, '');
  assert.throws(() => readPrivateFile(file), SafeError);
  fs.writeFileSync(file, 'x'.repeat(8193));
  assert.throws(() => readPrivateFile(file), SafeError);
  assert.throws(() => readPrivateFile(temporary), SafeError);
});

test('CLI refuses piped secrets before touching storage and rejects secret argument options', () => {
  const script = fileURLToPath(new URL('./local_wallet.mjs', import.meta.url));
  const piped = spawnSync(process.execPath, [script, 'import', '--address', wallet.address],
    { input: wallet.privateKey + '\n' + password + '\n', encoding: 'utf8' });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /Piped input is refused/);
  assert(!piped.stdout.includes(wallet.privateKey));
  assert(!piped.stderr.includes(wallet.privateKey));
  assert(!piped.stdout.includes(password));
  assert(!piped.stderr.includes(password));
  const invalid = spawnSync(process.execPath, [script, 'import', '--password', 'synthetic-not-a-real-secret'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert(!invalid.stderr.includes('synthetic-not-a-real-secret'));
});
