import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECK_NAMES, INVENTORY_SCOPE, inputInventory, buildInventory, evidenceInventory, GENERATED_EVIDENCE, canonical, sha256, digestFile, verifyValidation } from './validation_inventory.mjs';

// These checks deploy only to an in-process local EVM. No wallet or RPC is used.
export function defaultChecks(root = process.cwd()) {
  const python = process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
  const researchPython = process.env.ORVIA_RESEARCH_PYTHON || python;
  const concurrency = process.env.ORVIA_TEST_CONCURRENCY || '3';
  if (!/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(concurrency))
    throw new Error('ORVIA_TEST_CONCURRENCY must be an integer from 1 to 32.');
  return [
    ['compile', process.execPath, ['scripts/compile.mjs']],
    ['evm_components', process.execPath, ['--test', `--test-concurrency=${concurrency}`, '--test-reporter=tap', ...fs.readdirSync(path.join(root, 'test')).filter(x => x.endsWith('.test.mjs')).sort().map(x => `test/${x}`)]],
    ['reference_oracle', researchPython, ['-m', 'unittest', 'discover', '-s', 'reference', '-p', 'test_*.py']],
    ['architecture_manifest', python, ['scripts/validate_manifest.py', '--self-test']],
    ['structure_audit', python, ['scripts/audit_structure.py', '--check']],
    ['pair_identity_audit', researchPython, ['scripts/audit_pair_identity.py', '--chemistry']],
    ['preparation_audit', process.execPath, ['scripts/check_preparation.mjs']],
    ['scientific_input_audit', researchPython, ['scripts/scientific_readiness.py', '--check', '--self-test']],
    ['alternative_model_audit', python, ['data/prepared_candidate/alternative_models/audit_public_models.py', '--check', '--self-test']]
  ];
}
export function runChecks({root = process.cwd(), ...options} = {}) {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const summaryPath = path.join(root, 'reports/validation_summary.json');
  const summary = {schemaVersion: 2, status: 'in_progress', passed: false,
    startedAt: new Date().toISOString(), projectVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
    scope: 'Local numerical primitives, alternative molecular dynamics paths, synthetic free-energy analysis, deployment rehearsal and source-data audits; not a prepared myosin calculation, integrated production RBFE or Robinhood fork validation.',
    inventoryScope: INVENTORY_SCOPE, requiredChecks: CHECK_NAMES, localChainId: 31337, nodeVersion: process.version, checks: []};
  const save = () => {fs.writeFileSync(summaryPath + '.tmp', JSON.stringify(summary, null, 2) + '\n');fs.renameSync(summaryPath + '.tmp', summaryPath);};
  // Invalidate prior success before discovery, compilation or any subprocess can fail.
  save();
  try {
    if (Object.keys(options).length) throw new Error('Validation commands are fixed; injected check commands are not accepted.');
    const checks = defaultChecks(root);
    summary.evmTestConcurrency = Number(checks[1][2].find(arg => arg.startsWith('--test-concurrency=')).split('=')[1]);
    if (canonical(checks.map(x => x[0])) !== canonical(CHECK_NAMES)) throw new Error('Expected exactly nine validation groups.');
    summary.inputInventory = inputInventory(root);
    summary.inputInventorySha256 = sha256(canonical(summary.inputInventory));save();
    // These are reproducible check outputs, not retained operational/review records.
    for (const name of GENERATED_EVIDENCE) fs.rmSync(path.join(root, name), {force: true});
    for (const [name, command, args] of checks) {
      const log = `reports/${name}.log`, logPath = path.join(root, log), descriptor = fs.openSync(logPath, 'w');let r;
      try {r = spawnSync(command, args, { cwd: root, stdio: ['ignore', descriptor, descriptor] });}
      finally {fs.closeSync(descriptor);}
      if (r.error) fs.appendFileSync(logPath, String(r.error));
      const passed = r.status === 0 && !r.error;
      summary.checks.push({ name, passed, exitCode: r.status, log, logSha256: digestFile(root, log) });
      process.stdout.write(`${name}: ${passed ? 'PASS' : 'FAIL'}\n`);
      if (passed && name === 'compile') summary.buildOutputs = buildInventory(root);
      save();
      if (!passed) {process.stderr.write(fs.readFileSync(logPath, 'utf8'));break;}
    }
    summary.status = 'completed';summary.passed = summary.checks.length === CHECK_NAMES.length && summary.checks.every(r => r.passed);
    if (summary.passed) {
      summary.generatedEvidence = evidenceInventory(root);
      const verified = verifyValidation(root, summary);
      if (!verified.passed) {summary.passed = false;summary.integrityErrors = verified.errors;}
    }
  } catch (error) {summary.status = 'failed';summary.passed = false;summary.error = error.message;process.stderr.write(error.message + '\n');}
  summary.createdAt = new Date().toISOString();save();return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/check.mjs')) {
  process.exitCode = runChecks().passed ? 0 : 1;
}
