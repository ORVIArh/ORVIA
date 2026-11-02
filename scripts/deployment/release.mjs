import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import solc from 'solc';
import { AbiCoder, Interface, getCreateAddress, getAddress, keccak256 } from 'ethers';

export const TARGET_CHAIN_ID = 4663;
export const LOCAL_CHAIN_ID = 31337;
export const RUNTIME_LIMIT = 96 * 1024;
export const INITCODE_LIMIT = 192 * 1024;
export const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function verificationBundle(root = process.cwd()) {
  const measured = JSON.parse(fs.readFileSync(path.join(root, 'reports/compiled_sizes.json')));
  if (measured.compiler !== solc.version()) throw new Error('Compiler version differs from measured build');
  const sources = {};
  for (const [file, expected] of Object.entries(measured.sources)) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Source path escapes release root');
    const content = fs.readFileSync(absolute, 'utf8');
    if (sha256(content) !== expected) throw new Error(`Source changed after compilation: ${file}`);
    sources[file] = { content };
  }
  const input = { language: 'Solidity', sources, settings: measured.settings };
  return { input, compiler: measured.compiler, sourceHashes: measured.sources,
    inputSha256: sha256(canonical(input)) };
}

// Add output-only metadata while retaining the exact source and codegen settings.
export function compileVerification(bundle) {
  const input = structuredClone(bundle.input);
  input.settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode.object',
    'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifacts = {};
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      artifacts[name] = { source: file, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
        deployedBytecode: '0x' + c.evm.deployedBytecode.object,
        immutableReferences: c.evm.deployedBytecode.immutableReferences || {} };
    }
  }
  return artifacts;
}

export function runtimeMatches(actual, artifact) {
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const got = Buffer.from(actual.slice(2), 'hex');
  if (!expected.length || expected.length !== got.length) return false;
  for (const refs of Object.values(artifact.immutableReferences || {})) {
    for (const { start, length } of refs) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || start + length > got.length) return false;
      got.fill(0, start, start + length); expected.fill(0, start, start + length);
    }
  }
  return got.equals(expected);
}

export function deploymentRequest(artifact, args) {
  const iface = new Interface(artifact.abi);
  const constructorArguments = iface.encodeDeploy(args);
  const data = artifact.bytecode + constructorArguments.slice(2);
  if (data.length / 2 - 1 > INITCODE_LIMIT) throw new Error('Initcode including constructor arguments exceeds planning limit');
  if (artifact.deployedBytecode.length / 2 - 1 > RUNTIME_LIMIT) throw new Error('Runtime exceeds planning limit');
  return { data, value: 0n, constructorArguments };
}

// This plan is the currently executable v0.4 fixture, not the 64-slot release.
export function periodicFixturePlan(owner, firstNonce = 0) {
  owner = getAddress(owner);
  if (!Number.isSafeInteger(firstNonce) || firstNonce < 0) throw new Error('Invalid starting nonce');
  const entries = [], addresses = {};
  const add = (key, contract, args) => {
    const nonce = firstNonce + entries.length;
    const address = getCreateAddress({ from: owner, nonce });
    addresses[key] = address; entries.push({ key, contract, address, nonce, args });
  };
  add('math', 'FloatMath', []);
  add('elementary', 'ElementaryMath', [addresses.math]);
  add('registry', 'ExperimentRegistry', [owner]);
  add('base', 'DatasetCatalog', [owner]);
  add('dynamics', 'DynamicsDataset', [owner, addresses.base]);
  add('dataset', 'PeriodicDataset', [owner, addresses.dynamics]);
  add('integrator', 'VelocityVerletKernel', [addresses.math]);
  add('bond', 'HarmonicBondKernel', [addresses.math]);
  add('angle', 'HarmonicAngleKernel', [addresses.math, addresses.elementary]);
  add('torsion', 'PeriodicTorsionKernel', [addresses.math, addresses.elementary]);
  add('lj', 'LennardJonesKernel', [addresses.math]);
  add('coulomb', 'CoulombPairKernel', [addresses.math]);
  add('geometry', 'OrthorhombicGeometry', [addresses.math]);
  add('nonbonded', 'SwitchedNonbondedKernel', [addresses.math, addresses.lj, addresses.coulomb]);
  const modules = Object.fromEntries(['registry', 'dataset', 'math', 'integrator', 'bond', 'angle',
    'torsion', 'lj', 'coulomb', 'elementary', 'geometry', 'nonbonded'].map(k => [k, addresses[k]]));
  add('engine', 'PeriodicDynamicsCoordinator', [owner, modules]);
  add('working', 'WorkingStatePage', [addresses.engine]);
  return { schemaVersion: 1, mode: 'local_periodic_fixture', completeProductionPlan: false,
    targetChainId: TARGET_CHAIN_ID, executionChainId: LOCAL_CHAIN_ID, owner, firstNonce,
    plannedProductionInstances: 64, entries, modules, addresses };
}

export const PRODUCTION_CAPABILITIES = Object.freeze([
  'prepared_input_loading_and_sealing',
  'minimization_and_constraints',
  'equilibration_and_production_sampling',
  'periodic_long_range_electrostatics',
  'alchemical_lambda_protocol',
  'onchain_complete_cross_state_energies',
  'predeclared_paired_repeats_and_sample_chronology',
  'free_energy_overlap_correlation_and_uncertainty_acceptance',
  'permissionless_resume_partition_and_fault_recovery',
  'full_model_target_execution_and_source_verification'
]);
export const WORKLOAD_PHASES = Object.freeze([
  'deployment_and_input_loading', 'equilibration', 'production_sampling',
  'alchemical_cross_state_energy', 'free_energy_and_uncertainty_analysis', 'recovery_and_state_io'
]);

export function productionAcceptanceBindings(manifest, validation, scientific, operator, sourceBundleSha256) {
  return { architectureVersion: manifest.architecture_version, targetChainId: TARGET_CHAIN_ID,
    sourceBundleSha256, manifestSha256: sha256(canonical(manifest)),
    scientificAuditSha256: sha256(canonical(scientific)), validationSha256: sha256(canonical(validation)),
    preparedModelSha256: scientific?.accepted_model_sha256,
    protocolKeccak256: manifest.production_protocol_keccak256,
    productionPlanSha256: operator?.productionPlanSha256 };
}

// Read-only local artifact loading. File hashes establish integrity, not the truth of a claim.
export function loadProductionAcceptanceEvidence(root, acceptance) {
  const records = Object.create(null);
  const realRoot = fs.realpathSync(root);
  for (const descriptor of acceptance?.evidence || []) {
    try {
      if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(descriptor.id || '') || Object.hasOwn(records, descriptor.id)) throw new Error('Duplicate or invalid evidence ID');
      if (!/^(reports|data)\/production\/[A-Za-z0-9_./-]+\.json$/.test(descriptor.path || '')
        || descriptor.path.split('/').includes('..')) throw new Error('Evidence path is outside the production evidence directories');
      const actual = fs.realpathSync(path.resolve(root, descriptor.path));
      if (!actual.startsWith(realRoot + path.sep)) throw new Error('Evidence path escapes the release root');
      const bytes = fs.readFileSync(actual), digest = sha256(bytes);
      if (digest !== descriptor.sha256) throw new Error('Evidence file hash differs from its descriptor');
      records[descriptor.id] = { sha256: digest, record: JSON.parse(bytes) };
    } catch (error) { records[descriptor.id || 'invalid'] = { error: error.message }; }
  }
  return records;
}

export function productionAcceptanceCheck(manifest, validation, scientific, operator, acceptance, context) {
  const blockers = [];
  if (!acceptance) return { passed: false, requiredCapabilities: PRODUCTION_CAPABILITIES,
    blockers: ['Production acceptance: complete end-to-end pipeline and measured full-system workload evidence is missing.'] };
  const expected = productionAcceptanceBindings(manifest, validation, scientific, operator, context?.sourceBundleSha256);
  const digestKeys = ['sourceBundleSha256', 'manifestSha256', 'scientificAuditSha256', 'validationSha256', 'preparedModelSha256', 'productionPlanSha256'];
  if (acceptance.schemaVersion !== 1 || acceptance.scope !== 'ORVIA-001-full-rbfe') blockers.push('Production acceptance: unsupported schema or incomplete protocol scope.');
  if (digestKeys.some(k => !/^[0-9a-f]{64}$/.test(expected[k] || ''))
      || !/^0x[0-9a-f]{64}$/.test(expected.protocolKeccak256 || '')) blockers.push('Production acceptance: current compiled source, accepted model or protocol binding is unavailable.');
  const bindingsMatch = value => value && Object.entries(expected).every(([key, v]) => v != null && value[key] === v);
  if (!bindingsMatch(acceptance.bindings)) blockers.push('Production acceptance: source/model/protocol/plan/audit bindings differ from the current release.');
  const descriptors = new Map();
  for (const item of acceptance.evidence || []) {
    if (!item?.id || descriptors.has(item.id)) blockers.push('Production acceptance: duplicate or missing evidence identifier.');
    descriptors.set(item?.id, item);
  }
  const checked = new Map();
  function evidence(id, kind) {
    const cacheKey = `${id}:${kind}`;
    if (checked.has(cacheKey)) return checked.get(cacheKey);
    const descriptor = descriptors.get(id), loaded = context?.evidenceRecords?.[id], record = loaded?.record;
    const valid = descriptor && /^[0-9a-f]{64}$/.test(descriptor.sha256 || '') && loaded?.sha256 === descriptor.sha256
      && !loaded.error && record?.schemaVersion === 1 && record.evidenceId === id && record.kind === kind
      && record.status === 'passed' && bindingsMatch(record.bindings);
    if (!valid) blockers.push(`Production acceptance: ${id || 'unnamed'} is missing verified ${kind} evidence bound to this release.`);
    checked.set(cacheKey, valid ? record : null); return valid ? record : null;
  }
  const capabilities = new Map();
  for (const entry of acceptance.capabilities || []) {
    if (!PRODUCTION_CAPABILITIES.includes(entry?.id) || capabilities.has(entry.id)) blockers.push('Production acceptance: unknown or duplicate capability identifier.');
    capabilities.set(entry?.id, entry);
  }
  for (const id of PRODUCTION_CAPABILITIES) {
    const entry = capabilities.get(id), record = entry && evidence(entry.evidenceId, 'pipeline_execution');
    if (!record || record.scope !== 'full_prepared_model_pipeline' || !record.capabilities?.includes(id)
      || record.execution?.chainId !== TARGET_CHAIN_ID || record.execution?.mode !== 'target_chain_fork'
      || !/^0x[0-9a-f]{64}$/.test(record.execution?.blockHash || '')) {
      blockers.push(`Production acceptance: end-to-end capability ${id} is not evidenced for the complete prepared model.`);
    }
  }
  const workload = acceptance.workload;
  const work = evidence(workload?.measurementEvidenceId, 'full_system_workload_measurement');
  const throughput = evidence(workload?.throughputEvidenceId, 'allocated_throughput_measurement');
  const positive = x => typeof x === 'string' && /^[1-9][0-9]{0,77}$/.test(x);
  let projectedGas = 0n, budgetPassed = false;
  const counts = scientific?.accepted_model_atom_counts;
  const modelCountsMatch = counts && ['complex', 'solvent'].every(leg => Number.isSafeInteger(counts[leg]) && counts[leg] > 0
    && work?.modelAtomCounts?.[leg] === counts[leg]);
  if (!modelCountsMatch || work?.scope !== 'full_prepared_model_complete_protocol' || work?.execution?.chainId !== TARGET_CHAIN_ID
    || work?.execution?.mode !== 'target_chain_fork' || !/^0x[0-9a-f]{64}$/.test(work?.execution?.blockHash || '')) {
    blockers.push('Production acceptance: workload measurements are not for both complete accepted systems on a target-chain fork.');
  }
  const phases = new Map();
  for (const phase of work?.phaseMeasurements || []) {
    if (!WORKLOAD_PHASES.includes(phase.phase)) blockers.push('Production acceptance: unknown workload phase would escape the complete budget.');
    if (phases.has(phase.phase)) blockers.push('Production acceptance: duplicate workload phase.');
    phases.set(phase.phase, phase);
  }
  for (const name of WORKLOAD_PHASES) {
    const phase = phases.get(name);
    if (!positive(phase?.measuredGasPerUnit) || !positive(phase?.campaignUnits)) blockers.push(`Production acceptance: measured full-campaign phase ${name} is missing.`);
    else projectedGas += BigInt(phase.measuredGasPerUnit) * BigInt(phase.campaignUnits);
  }
  const realThroughput = throughput?.scope === 'observed_allocated_target_chain_gas'
    && throughput.execution?.chainId === TARGET_CHAIN_ID && throughput.execution?.mode === 'target_chain_observation'
    && /^0x[0-9a-f]{64}$/.test(throughput.execution?.startBlockHash || '')
    && /^0x[0-9a-f]{64}$/.test(throughput.execution?.endBlockHash || '')
    && positive(throughput.observedAllocatedGas) && positive(throughput.observationSeconds);
  if (!realThroughput) blockers.push('Production acceptance: observed target-chain application allocation is missing; hypothetical throughput is insufficient.');
  if (realThroughput && positive(workload?.gasBudget) && positive(workload?.maxDurationSeconds)
    && workload.maxDurationSeconds === operator?.acceptedMaxDurationSeconds
    && positive(work?.maxTransactionGas) && positive(throughput?.transactionGasLimit)) {
    const rate = BigInt(throughput.observedAllocatedGas) / BigInt(throughput.observationSeconds);
    const budget = BigInt(workload.gasBudget), duration = BigInt(workload.maxDurationSeconds);
    budgetPassed = rate > 0n && projectedGas > 0n && budget >= projectedGas
      && (budget + rate - 1n) / rate <= duration
      && BigInt(work.maxTransactionGas) <= BigInt(throughput.transactionGasLimit);
  }
  if (!budgetPassed) blockers.push('Production acceptance: full-system gas, per-transaction limit and operator-accepted duration budget do not pass.');
  return { passed: blockers.length === 0, requiredCapabilities: PRODUCTION_CAPABILITIES, requiredWorkloadPhases: WORKLOAD_PHASES,
    projectedMeasuredPhaseGas: projectedGas.toString(), budgetPassed, blockers,
    notice: 'Hashes check artifact integrity and release binding; they do not prove report truth, scientific convergence, independent review or future chain allocation.' };
}

export function readinessReport(manifest, validation, preflight, slotEvidence = [], scientific = null, operator = null, acceptance = null, acceptanceContext = null) {
  const problems = [];
  const slots = manifest.slots || [];
  const evidence = new Map(slotEvidence.map(x => [x.slot, x]));
  const planned = manifest.requirements?.planned_production_instances;
  const minimum = manifest.requirements?.minimum_production_contracts;
  if (!Number.isSafeInteger(planned) || !Number.isSafeInteger(minimum) || minimum < 50 || planned < minimum || slots.length !== planned) {
    problems.push('The justified production-slot count does not match the declared plan/minimum.');
  }
  if (new Set(slots.map(x => x.id)).size !== slots.length) problems.push('Production slot IDs are not unique.');
  if (manifest.target?.chain_id !== TARGET_CHAIN_ID) problems.push('The target chain is not Robinhood mainnet 4663.');
  if (!manifest.requirements?.compiled_production_system) problems.push('The complete production system is not compiled.');
  if (!manifest.requirements?.scientifically_validated) problems.push('Scientific input/method validation is incomplete.');
  if (manifest.scientific_blockers?.length) problems.push('Scientific blockers remain recorded.');
  if (scientific?.ready_for_orvia_001_registration !== true) problems.push('The prepared ORVIA-001 model is not accepted by the scientific-readiness audit.');
  if (!validation?.passed || validation.projectVersion !== manifest.architecture_version) problems.push('A passing current-version full validation run is missing.');
  if (preflight?.status !== 'verified_read_only' || preflight.chain_id_observed !== TARGET_CHAIN_ID) problems.push('Live mainnet RPC verification is incomplete.');
  const operatorConfigured = /^0x[0-9a-fA-F]{40}$/.test(operator?.address || '')
    && !/^0x0{40}$/.test(operator.address) && Number.isSafeInteger(operator.startNonce) && operator.startNonce >= 0
    && /^[0-9a-f]{64}$/.test(operator.productionPlanSha256 || '')
    && operator.liveFeeQuotesVerified === true && operator.preparedTransactionCount > 0;
  if (!operatorConfigured) problems.push('A public operator, nonce-pinned production plan and verified live fee quotes are missing.');
  const productionAcceptance = productionAcceptanceCheck(manifest, validation, scientific, operator, acceptance, acceptanceContext);
  problems.push(...productionAcceptance.blockers);
  const inventory = slots.map(slot => {
    const candidates = (manifest.experimental_source_candidates || []).filter(x => x.related_slots.includes(slot.id)).map(x => x.path);
    const entry = evidence.get(slot.id);
    const code = slot.code || {};
    const measured = ['source_bundle_sha256', 'runtime_code_keccak256', 'runtime_size_bytes', 'initcode_size_bytes'].every(k => code[k] != null);
    const validated = ['validated', 'deployed'].includes(slot.production_status) && measured;
    if (!validated) problems.push(`${slot.id}: complete measured production implementation is not validated.`);
    if (!entry?.targetForkSimulationPassed || !entry?.sourceVerificationRehearsalPassed || !entry?.worstCaseGasMeasured) {
      problems.push(`${slot.id}: target-fork, source-verification or maximum-work gas evidence is missing.`);
    }
    if (slot.category === 'input_storage' && (!slot.data?.sealed || !(slot.data.size_bytes > 0))) problems.push(`${slot.id}: prepared populated sealed data is missing.`);
    return { slot: slot.id, name: slot.name, category: slot.category, productionStatus: slot.production_status,
      validated, experimentalCandidates: candidates, implementationState: validated ? 'validated' : candidates.length ? 'experimental_candidates_only' : 'no_registered_candidate' };
  });
  return { schemaVersion: 1, readyForMainnet: problems.length === 0, broadcastEnabled: false,
    targetChainId: TARGET_CHAIN_ID, plannedInstances: slots.length, completeValidatedSlots: inventory.filter(x => x.validated).length,
    inventory, productionAcceptance, blockers: problems,
    blockerGroups: {
      externalEvidence: preflight?.status === 'verified_read_only' && preflight.chain_id_observed === TARGET_CHAIN_ID ? [] : ['Working Robinhood mainnet RPC access is unavailable or unverified.'],
      scientificInputs: scientific?.ready_for_orvia_001_registration === true ? [] : ['A complete validated prepared myosin/ligand/solvent model, including special cofactor and modified-residue parameters, is unresolved.'],
      productionPipelineAndWorkload: productionAcceptance.blockers,
      implementationAndValidation: problems.filter(x => !x.startsWith('Live mainnet RPC') && !x.startsWith('The prepared ORVIA-001') && !x.startsWith('A public operator')),
      operatorConfiguration: operatorConfigured ? [] : ['Final public operator address, nonce-pinned production plan and live per-transaction fee quotes are required before signing. No private key belongs in the release bundle.']
    },
    notice: 'A structural gate cannot certify scientific correctness or independent security review. No signer or broadcaster is provided by this tool.' };
}

export function assertReadOnlyRehearsalChain(chainId) {
  if (BigInt(chainId) !== BigInt(LOCAL_CHAIN_ID)) throw new Error('Deployment rehearsal refuses non-local chain IDs');
}

export function sourceVerificationDescriptor(entry, artifact, receipt, code, bundle) {
  const request = deploymentRequest(artifact, entry.args);
  return { label: entry.key, contract: entry.contract, fullyQualifiedName: `${artifact.source}:${entry.contract}`,
    address: entry.address, compiler: bundle.compiler, standardInputSha256: bundle.inputSha256,
    constructorArguments: request.constructorArguments, deploymentTransactionHash: receipt.hash,
    runtimeCodeKeccak256: keccak256(code), runtimeBytes: (code.length - 2) / 2,
    initcodeBytesIncludingArguments: (request.data.length - 2) / 2,
    sourceVerifiedOnExplorer: false, compilerTemplateMatchedOutsideImmutables: runtimeMatches(code, artifact) };
}
