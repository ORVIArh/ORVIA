import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CHECK_NAMES = Object.freeze(['compile', 'evm_components', 'reference_oracle',
  'architecture_manifest', 'structure_audit', 'pair_identity_audit', 'preparation_audit',
  'scientific_input_audit', 'alternative_model_audit']);
export const INPUT_DIRECTORIES = Object.freeze(['contracts', 'test', 'reference', 'scripts', 'data']);
export const INPUT_FILES = Object.freeze(['package.json', 'package-lock.json', 'requirements-research.txt']);
export const OPERATIONAL_DATA_FILES = Object.freeze(['data/production_acceptance.json', 'data/operator_deployment.json', 'data/production_slot_evidence.json']);
export const GENERATED_EVIDENCE = Object.freeze([
  'angular_validation', 'constrained_reference', 'constrained_validation', 'constrained_execution_gas',
  'constraints_validation', 'constraints_execution_gas', 'deployment_fixture_plan', 'deployment_rehearsal',
  'deployment_standard_input', 'dynamics_validation', 'dynamics_execution_gas', 'local_execution_gas',
  'paged_execution_gas', 'ewald_validation', 'ewald_execution_gas', 'ewald_dynamics_validation',
  'ewald_dynamics_execution_gas', 'inline_nonbonded_gas', 'langevin_reference', 'langevin_validation',
  'langevin_execution_gas', 'mbar_validation', 'mbar_execution_gas', 'minimizer_validation',
  'minimizer_execution_gas', 'neighbor_validation', 'neighbor_execution_gas', 'nonbonded_validation',
  'numerical_validation', 'periodic_dynamics_validation', 'periodic_dynamics_execution_gas',
  'scalar_random_validation', 'softcore_validation', 'switched_nonbonded_validation',
  'timeseries_validation', 'timeseries_execution_gas'
].map(name => `reports/${name}.json`));
export const BUILD_OUTPUTS = Object.freeze(['reports/compiled_sizes.json', 'build/artifacts.json']);
export const INVENTORY_SCOPE = 'Exact contracts/test/reference/scripts/data file sets and package/dependency pins; excludes Python caches, docs/release notes and operational data/production_acceptance.json, data/operator_deployment.json, data/production_slot_evidence.json and data/production/ evidence (separately bound by readiness). Compiler artifacts, generated numerical/deployment evidence and all nine check logs are separately hash-bound; readiness/preflight/review/package metadata are excluded.';
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const digestFile = (root, name) => {
  const file = path.join(root, name), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Validated artifact is not a regular file: ${name}`);
  return sha256(fs.readFileSync(file));
};
export const canonical = x => x && typeof x === 'object'
  ? Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
    : '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'
  : JSON.stringify(x);
export function inputInventory(root = process.cwd()) {
  const names = [...INPUT_FILES];
  function walk(relative) {
    if (OPERATIONAL_DATA_FILES.includes(relative) || relative === 'data/production') return;
    const info = fs.lstatSync(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Validation input symlink is unsupported: ${relative}`);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
        if (name === '__pycache__' || name.endsWith('.pyc')) continue;
        walk(relative + '/' + name);
      }
    } else if (info.isFile()) names.push(relative);
    else throw new Error(`Unsupported validation input: ${relative}`);
  }
  for (const directory of INPUT_DIRECTORIES) walk(directory);
  return Object.fromEntries(names.sort().map(name => {
    if (!fs.lstatSync(path.join(root, name)).isFile() || fs.lstatSync(path.join(root, name)).isSymbolicLink())
      throw new Error(`Validation input is not a regular file: ${name}`);
    return [name, digestFile(root, name)];
  }));
}
export function buildInventory(root = process.cwd()) {
  return Object.fromEntries(BUILD_OUTPUTS.map(name => [name, digestFile(root, name)]));
}
export function evidenceInventory(root = process.cwd()) {
  return Object.fromEntries(GENERATED_EVIDENCE.map(name => [name, digestFile(root, name)]));
}
export function verifyValidation(root = process.cwd(), provided) {
  const errors = [];let validationSummarySha256;
  try {
    const summaryBytes = provided ? null : fs.readFileSync(path.join(root, 'reports/validation_summary.json'));
    if (summaryBytes) validationSummarySha256 = sha256(summaryBytes);
    const summary = provided ?? JSON.parse(summaryBytes);
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
    if (summary.schemaVersion !== 2 || summary.status !== 'completed' || summary.passed !== true)
      errors.push('A completed version-2 full validation run is required; interrupted or legacy success is not accepted.');
    if (summary.projectVersion !== version) errors.push('Validation belongs to a different project version.');
    if (canonical(summary.requiredChecks) !== canonical(CHECK_NAMES)
      || canonical((summary.checks || []).map(x => x.name)) !== canonical(CHECK_NAMES))
      errors.push('Validation does not contain exactly the nine required checks in order.');
    const current = inputInventory(root);
    if (canonical(summary.inputInventory) !== canonical(current)) errors.push('Validation input files were added, removed or changed after this run.');
    if (summary.inputInventorySha256 !== sha256(canonical(current))) errors.push('Validation input inventory digest differs.');
    const outputs = buildInventory(root);
    if (canonical(summary.buildOutputs) !== canonical(outputs)) errors.push('Compiler report or artifacts changed after this run.');
    if (canonical(summary.generatedEvidence) !== canonical(evidenceInventory(root))) errors.push('Generated numerical or deployment evidence changed after validation.');
    const compiled = JSON.parse(fs.readFileSync(path.join(root, 'reports/compiled_sizes.json')));
    const solidity = Object.fromEntries(Object.entries(current).filter(([name]) =>
      name.endsWith('.sol') && (name.startsWith('contracts/') || name.startsWith('test/contracts/'))));
    if (canonical(compiled.sources) !== canonical(solidity)) errors.push('Compiled Solidity source set or hashes differ from validated inputs.');
    for (const check of summary.checks || []) {
      const expectedPath = `reports/${check.name}.log`;
      if (!CHECK_NAMES.includes(check.name) || check.passed !== true || check.exitCode !== 0 || check.log !== expectedPath)
        errors.push(`Invalid completed check record: ${check.name}`);
      else if (check.logSha256 !== digestFile(root, expectedPath)) errors.push(`Check log changed after validation: ${check.name}`);
    }
  } catch (error) { errors.push(error.message); }
  return { passed: errors.length === 0, errors, scope: INVENTORY_SCOPE, validationSummarySha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/validation_inventory.mjs')) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify') throw new Error('Usage: node scripts/validation_inventory.mjs --verify');
  const result = verifyValidation(); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
}
