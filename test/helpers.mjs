import fs from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory } from 'ethers';

export const artifacts = JSON.parse(fs.readFileSync('build/artifacts.json', 'utf8'));
export async function environment() {
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: { totalAccounts: 3 },
    miner: { blockGasLimit: 30000000 }
  });
  const provider = new BrowserProvider(transport);
  provider.pollingInterval = 10;
  return { transport, provider, owner: await provider.getSigner(0), contributor: await provider.getSigner(1) };
}
export async function deploy(name, signer, args = []) {
  const a = artifacts[name];
  if (!a) throw new Error('Missing artifact ' + name);
  const contract = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}
export async function transact(promise) {
  return await (await promise).wait();
}
export function quadFromNumber(x) {
  if (!Number.isFinite(x)) throw new Error('finite only');
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(x);
  const b = buf.readBigUInt64BE();
  const sign = b >> 63n;
  const exponent = (b >> 52n) & 2047n;
  const frac = b & ((1n << 52n) - 1n);
  let bits;
  if (exponent === 0n) {
    if (frac === 0n) bits = sign << 127n;
    else {
      const top = BigInt(frac.toString(2).length - 1);
      const unbiased = top - 1074n;
      bits = (sign << 127n) | ((unbiased + 16383n) << 112n) |
        ((frac - (1n << top)) << (112n - top));
    }
  } else {
    bits = (sign << 127n) | ((exponent - 1023n + 16383n) << 112n) | (frac << 60n);
  }
  return '0x' + bits.toString(16).padStart(32, '0');
}
export function quadToNumber(hex) {
  const bits = BigInt(hex), neg = (bits >> 127n) !== 0n;
  const exponent = Number((bits >> 112n) & 32767n);
  const frac = bits & ((1n << 112n) - 1n);
  if (exponent === 32767) return frac ? NaN : neg ? -Infinity : Infinity;
  const magnitude = exponent === 0
    ? Number(frac) * 2 ** (-16382 - 112)
    : (1 + Number(frac) / 2 ** 112) * 2 ** (exponent - 16383);
  return neg ? -magnitude : magnitude;
}
export const qvec = xs => xs.map(quadFromNumber);
