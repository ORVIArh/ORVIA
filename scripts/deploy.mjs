import fs from 'node:fs';
import { verifyValidation } from './validation_inventory.mjs';
import { verificationBundle, compileVerification, readinessReport, loadProductionAcceptanceEvidence } from './deployment/release.mjs';
import { rehearsePeriodicFixture } from './deployment/rehearsal.mjs';

// This checkpoint deliberately has no signer-loading or remote broadcast path.
const command = process.argv[2];
if (process.argv.length !== 3 || !['--local-rehearsal', '--readiness', '--verification-input'].includes(command)) {
  console.error('Usage: node scripts/deploy.mjs --local-rehearsal | --readiness | --verification-input');
  console.error('Mainnet broadcast is not implemented or enabled by this checkpoint.');
  process.exitCode = 2;
} else {
  try {
    if (command === '--readiness') {
      const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
      const acceptance = read('data/production_acceptance.json');
      const validation = read('reports/validation_summary.json');
      const validationIntegrity = verifyValidation(process.cwd(), validation);
      let sourceBundleSha256 = null;
      // A stale or unavailable compiled source bundle must fail readiness, not become a trusted declaration.
      try { sourceBundleSha256 = verificationBundle().inputSha256; } catch { /* reported by acceptance gate */ }
      const report = readinessReport(read('data/contract_manifest.json'), validationIntegrity.passed ? validation : { ...validation, passed: false },
        read('reports/mainnet_preflight.json'), read('data/production_slot_evidence.json') || [], read('data/scientific_readiness.json'), read('data/operator_deployment.json'),
        acceptance, { sourceBundleSha256, evidenceRecords: loadProductionAcceptanceEvidence(process.cwd(), acceptance) });
      report.validationIntegrity = validationIntegrity;
      if (!validationIntegrity.passed) {
        report.readyForMainnet = false;
        report.blockers.push(...validationIntegrity.errors.map(x => 'Validation integrity: ' + x));
      }
      fs.writeFileSync('reports/mainnet_readiness.json', JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ readyForMainnet: report.readyForMainnet,
        completeValidatedSlots: report.completeValidatedSlots, blockers: report.blockers.length,
        report: 'reports/mainnet_readiness.json', mainnetTransactionsSent: 0 }));
      process.exitCode = report.readyForMainnet ? 0 : 2;
    } else {
      const bundle = verificationBundle();
      if (command === '--verification-input') {
        fs.writeFileSync('reports/deployment_standard_input.json', JSON.stringify(bundle.input, null, 2) + '\n');
        console.log(JSON.stringify({ compiler: bundle.compiler, standardInputCanonicalSha256: bundle.inputSha256,
          report: 'reports/deployment_standard_input.json' }));
      } else {
        const artifacts = compileVerification(bundle);
        const fixture = JSON.parse(fs.readFileSync('reference/periodic_reference.json'));
        const report = await rehearsePeriodicFixture({ bundle, artifacts, fixture, outputDirectory: 'reports' });
        console.log(JSON.stringify({ passed: report.passed, totalLocalInstances: report.totalLocalInstances,
          totalMeasuredGas: report.totalMeasuredGas, mainnetTransactionsSent: 0,
          report: 'reports/deployment_rehearsal.json' }));
      }
    }
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
