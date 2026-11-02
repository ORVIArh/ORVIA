// Offline-only wallet import/check. Never pass secrets as arguments or environment variables.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Wallet, getAddress, encryptKeystoreJson, decryptKeystoreJson } from 'ethers';

export class SafeError extends Error {}
const requireSafe = (condition, message) => { if (!condition) throw new SafeError(message); };
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1 });
const MAX_FILE_BYTES = 8192;
const uid = () => process.getuid();
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const inputCheckpoint = async () => {
  // The pinned scrypt implementation yields microtasks, which can starve TTY I/O.
  // Cross two check phases so a poll phase consumes cancellation before saving.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

export function walletLocation() {
  // Read the OS account, not HOME (which can be overridden by a launcher).
  const home = os.userInfo().homedir;
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const directory = path.join(home, '.orvia', 'keystores');
  requireSafe(!within(directory, workspace), 'Wallet storage must be outside the project workspace.');
  return { home, directory, file: path.join(directory, 'report-signer.json') };
}

export function secureDirectory(home, directory, create = false) {
  requireSafe(path.isAbsolute(home) && path.isAbsolute(directory) && path.resolve(home) === home
    && path.resolve(directory) === directory && within(directory, home) && directory !== home,
    'Invalid private wallet directory.');
  // Reject symlinked path components. Never chmod the account home or its ancestors.
  let cursor = path.parse(home).root;
  for (const component of home.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const s = fs.lstatSync(cursor);
    requireSafe(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022) === 0,
      'Wallet parent directories must be real directories without public write access.');
  }
  requireSafe(fs.lstatSync(home).uid === uid(), 'Wallet home belongs to another account.');
  cursor = home;
  for (const component of path.relative(home, directory).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (create) {
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const s = fs.lstatSync(cursor);
    requireSafe(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid() && (s.mode & 0o777) === 0o700,
      'Wallet directories must be owned by you and have permissions 0700.');
  }
}

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${size * 2}}$`).test(value);

export function validateKeystore(json, expectedAddress) {
  requireSafe(typeof json === 'string' && Buffer.byteLength(json) <= MAX_FILE_BYTES, 'Invalid wallet file.');
  let data;
  try { data = JSON.parse(json); } catch { throw new SafeError('Invalid wallet file.'); }
  const c = data?.Crypto, k = c?.kdfparams;
  requireSafe(exactKeys(data, ['address', 'id', 'version', 'Crypto']) && data.version === 3
    && hex(data.address, 20) && typeof data.id === 'string'
    && /^[0-9a-f-]{36}$/i.test(data.id)
    && exactKeys(c, ['cipher', 'cipherparams', 'ciphertext', 'kdf', 'kdfparams', 'mac'])
    && c.cipher === 'aes-128-ctr' && c.kdf === 'scrypt'
    && exactKeys(c.cipherparams, ['iv']) && hex(c.cipherparams.iv, 16)
    && hex(c.ciphertext, 32) && hex(c.mac, 32)
    && exactKeys(k, ['salt', 'n', 'r', 'p', 'dklen']) && hex(k.salt, 32)
    && k.n === SCRYPT.N && k.r === SCRYPT.r && k.p === SCRYPT.p && k.dklen === 32,
    'Unsupported or damaged wallet file. Only this tool’s bounded V3 format is accepted.');
  requireSafe(getAddress('0x' + data.address) === getAddress(expectedAddress), 'Wallet file belongs to a different public address.');
  return data;
}

export function privateAccount(privateKey, expectedAddress) {
  requireSafe(typeof privateKey === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey),
    'Enter one 64-digit hexadecimal private key, not a recovery phrase.');
  let wallet;
  try { wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey); }
  catch { throw new SafeError('Invalid private key.'); }
  requireSafe(wallet.address === getAddress(expectedAddress), 'That private key does not match the expected public wallet. Nothing was saved.');
  return wallet;
}

export function checkPassword(password, confirmation) {
  requireSafe(password === confirmation, 'Passwords did not match. Nothing was saved.');
  requireSafe([...password.normalize('NFKC')].length >= 16 && Buffer.byteLength(password) <= 1024,
    'Use a unique password or passphrase of at least 16 characters.');
}

export async function encryptVerified(account, password) {
  try {
    const json = await encryptKeystoreJson({ address: account.address, privateKey: account.privateKey }, password, { scrypt: SCRYPT });
    validateKeystore(json, account.address);
    const recovered = await decryptKeystoreJson(json, password);
    requireSafe(recovered.address === account.address && recovered.privateKey === account.privateKey,
      'Encrypted wallet verification failed. Nothing was saved.');
    return json;
  } catch { throw new SafeError('Could not encrypt and verify the wallet. Nothing was saved.'); }
}

export async function decryptVerified(json, password, expectedAddress) {
  validateKeystore(json, expectedAddress);
  try {
    const account = await decryptKeystoreJson(json, password);
    requireSafe(account.address === getAddress(expectedAddress), 'Wallet address mismatch.');
    return new Wallet(account.privateKey); // Offline: deliberately no provider.
  } catch { throw new SafeError('Wallet could not be unlocked. Check the password and wallet file.'); }
}

export function saveExclusive(file, json, expectedAddress) {
  validateKeystore(json, expectedAddress);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    const s = fs.fstatSync(fd);
    requireSafe(s.isFile() && s.uid === uid() && s.nlink === 1 && (s.mode & 0o777) === 0o600, 'Unsafe wallet file permissions.');
    fs.writeFileSync(fd, json + '\n', { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new SafeError('A wallet file already exists. It was not changed. Use unlock-check.');
    throw new SafeError('Could not save the encrypted wallet. Inspect the destination before retrying.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readPrivateFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    requireSafe(s.isFile() && s.uid === uid() && s.nlink === 1 && (s.mode & 0o777) === 0o600
      && s.size > 0 && s.size <= MAX_FILE_BYTES, 'Wallet file must be a private regular file owned by you (0600).');
    // Bound reads even if a same-user process changes the file after fstat.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    requireSafe(length <= MAX_FILE_BYTES, 'Wallet file is too large.');
    return bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('Cannot securely open the encrypted wallet file.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const flushTerminalInput = () => {
  // Node has no public tcflush API. Isolated system Python sees only the inherited TTY,
  // never the secret in arguments, environment, stdout or a plaintext file.
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', 'import termios; termios.tcflush(0, termios.TCIFLUSH)'],
    { stdio: ['inherit', 'ignore', 'ignore'], timeout: 2000 });
  requireSafe(result.status === 0, 'Secure Terminal input cleanup is unavailable. Use the system Python 3 installation.');
  while (process.stdin.read() !== null) { /* discard Node-buffered typeahead */ }
};

export async function withHiddenSession(operation) {
  requireSafe(process.stdin.isTTY && process.stdout.isTTY, 'Run this command in your own local Terminal. Piped input is refused.');
  flushTerminalInput(); // Fail before asking for a secret if the cleanup facility is unavailable.
  const wasRaw = process.stdin.isRaw;
  let restored = false;
  const restore = () => {
    if (restored) return;
    flushTerminalInput();
    process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
    restored = true;
  };
  const stop = () => {
    try { restore(); } catch { process.stderr.write('\nTerminal cleanup failed; close this Terminal window.\n'); }
    process.stdout.write('\nCancelled.\n'); process.exit(130);
  };
  // Keep consuming input during encryption/decryption, when no prompt listener exists.
  const discardOrCancel = chunk => { if (chunk.includes('\x03') || chunk.includes('\x04')) stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.on('data', discardOrCancel);
  process.stdin.resume();
  try { return await operation(); }
  finally {
    try { restore(); }
    finally {
      process.stdin.off('data', discardOrCancel);
      process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop);
    }
  }
}

// The entire interactive session stays in raw/no-echo mode, including encryption.
// No readline history, secret arguments, environment variables or plaintext files.
export function hiddenPrompt(label, maxBytes = 1024) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) { value = ''; reject(new SafeError(error)); } else { resolve(value); value = ''; }
    };
    const onData = chunk => {
      // Accept a single-line paste; reject escape codes, multiline pastes and control characters.
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (c === '\x03' || c === '\x04') return finish('Cancelled.');
        if (c === '\r' || c === '\n') {
          if (i !== chunk.length - 1) return finish('Enter one line at a time; multiline input was rejected.');
          return finish();
        }
        if (c === '\x7f' || c === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (/[\x00-\x1f\x80-\x9f]/.test(c)) return finish('Unsupported control character; input was rejected.');
        value += c;
        if (Buffer.byteLength(value) > maxBytes) return finish('Input is too long.');
      }
    };
    process.stdout.write(label);
    process.stdin.on('data', onData);
  });
}

export async function main(args = process.argv.slice(2)) {
  requireSafe(args.length === 3 && ['import', 'unlock-check'].includes(args[0]) && args[1] === '--address',
    'Usage: node local_wallet.mjs import|unlock-check --address 0xPUBLIC_ADDRESS');
  let address;
  try { address = getAddress(args[2]); } catch { throw new SafeError('Invalid public wallet address.'); }
  requireSafe(process.stdin.isTTY && process.stdout.isTTY, 'Run this command in your own local Terminal. Piped input is refused.');
  const location = walletLocation();
  secureDirectory(location.home, location.directory, args[0] === 'import');
  if (args[0] === 'import') {
    try { fs.lstatSync(location.file); throw new SafeError('A wallet file already exists. It was not changed. Use unlock-check.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let account, key, password, confirmation;
  try {
    await withHiddenSession(async () => {
      process.stdout.write(`ORVIA offline wallet ${args[0]}\nPublic address: ${address}\nNo transaction will be sent. Secret input is hidden.\n`);
      if (args[0] === 'import') {
        key = await hiddenPrompt('Private key (local input only): ', 66);
        account = privateAccount(key, address); key = undefined;
        password = await hiddenPrompt('New password (at least 16 characters): ');
        confirmation = await hiddenPrompt('Confirm password: ');
        checkPassword(password, confirmation); confirmation = undefined;
        process.stdout.write('Encrypting and checking recovery...\n');
        const json = await encryptVerified(account, password);
        await inputCheckpoint();
        secureDirectory(location.home, location.directory);
        saveExclusive(location.file, json, address);
        process.stdout.write(`Encrypted wallet saved: ${location.file}\nAddress verified: ${address}\nKeep the password in your password manager and an encrypted backup outside GitHub.\n`);
      } else {
        const json = readPrivateFile(location.file);
        validateKeystore(json, address);
        password = await hiddenPrompt('Wallet password (local input only): ');
        account = await decryptVerified(json, password, address);
        await inputCheckpoint();
        process.stdout.write(`Wallet unlock verified: ${account.address}\nNo signature or transaction was produced.\n`);
      }
    });
  } finally {
    // JS/ethers string copies cannot be reliably zeroized; exit after this short-lived operation.
    account = key = password = confirmation = undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0)).catch(error => {
    // Never print raw library errors: they may contain a rejected secret argument.
    process.stderr.write((error instanceof SafeError ? error.message : 'Wallet operation failed. No secret details are logged.') + '\n');
    process.exit(1);
  });
}
