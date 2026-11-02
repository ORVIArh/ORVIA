import { getAddress, TypedDataEncoder } from 'ethers';

export const DOMAIN_NAME = 'ORVIAHybridCoordinator';
export const DOMAIN_VERSION = '1';
export const REPORT_TYPES = Object.freeze({Report: Object.freeze([
  {name:'runId',type:'bytes32'},
  {name:'configurationHash',type:'bytes32'},
  {name:'sequence',type:'uint64'},
  {name:'completedSteps',type:'uint64'},
  {name:'previousCheckpointHash',type:'bytes32'},
  {name:'checkpointHash',type:'bytes32'},
  {name:'resultHash',type:'bytes32'},
  {name:'outcome',type:'uint8'},
  {name:'checks',type:'uint32'},
  {name:'validUntil',type:'uint64'},
].map(Object.freeze))});

export function domain(chainId, verifyingContract) {
  const chain = BigInt(chainId);
  if (chain <= 0n) throw new Error('Positive chain ID required');
  return {name:DOMAIN_NAME,version:DOMAIN_VERSION,chainId:chain,verifyingContract:getAddress(verifyingContract)};
}
export function normalizeReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Report object required');
  const fields = REPORT_TYPES.Report;
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.some(x=>x.name===k))) throw new Error('Exact report fields required');
  const output = {};
  for (const {name,type} of fields) {
    const raw = value[name];
    if (type === 'bytes32') {
      if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Invalid ${name}`);
      output[name] = raw.toLowerCase();
    } else {
      if (typeof raw === 'number' && !Number.isSafeInteger(raw)) throw new Error(`Unsafe integer ${name}`);
      if (!['number','bigint','string'].includes(typeof raw) || typeof raw === 'string' && !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid integer ${name}`);
      const n = BigInt(raw), bits = BigInt(type.slice(4));
      if (n < 0n || n >= 1n << bits) throw new Error(`Out-of-range ${name}`);
      output[name] = n;
    }
  }
  if (output.outcome > 2n) throw new Error('Unknown report outcome');
  return output;
}
export function reportDigest(chainId, verifyingContract, value) {
  return TypedDataEncoder.hash(domain(chainId,verifyingContract),REPORT_TYPES,normalizeReport(value));
}
