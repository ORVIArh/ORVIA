import fs from 'node:fs';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

const file = new URL('./ORVIAResultAnchor.sol', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'ORVIAResultAnchor.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter(x => x.severity === 'error');
if (errors.length) throw new Error(errors.map(x => x.formattedMessage).join('\n'));
const artifact = output.contracts['ORVIAResultAnchor.sol'].ORVIAResultAnchor;

const raw = ganache.provider({
  chain: { chainId: 4663, hardfork: 'shanghai' },
  wallet: { totalAccounts: 3 },
  logging: { quiet: true },
});
try {
  const provider = new BrowserProvider(raw);
  const operatorKey = Object.values(raw.getInitialAccounts())[0].secretKey;
  const operator = new Wallet(operatorKey, provider);
  const relayer = await provider.getSigner(1);
  const factory = new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, operator);
  const deployed = await factory.deploy(await operator.getAddress());
  const deploymentReceipt = await deployed.deploymentTransaction().wait();
  const report = {
    inputHash: `0x${'11'.repeat(32)}`,
    methodHash: `0x${'22'.repeat(32)}`,
    settingsHash: `0x${'33'.repeat(32)}`,
    outputHash: `0x${'44'.repeat(32)}`,
    atomCount: 132935,
    sampleCount: 1000,
  };
  const signature = await operator.signTypedData(
    { name: 'ORVIAResultAnchor', version: '1', chainId: 4663, verifyingContract: await deployed.getAddress() },
    { Report: [
      { name: 'inputHash', type: 'bytes32' },
      { name: 'methodHash', type: 'bytes32' },
      { name: 'settingsHash', type: 'bytes32' },
      { name: 'outputHash', type: 'bytes32' },
      { name: 'atomCount', type: 'uint32' },
      { name: 'sampleCount', type: 'uint64' },
    ] }, report,
  );
  const anchor = deployed.connect(relayer);
  const tx = await anchor.anchor(
    report.inputHash, report.methodHash, report.settingsHash, report.outputHash,
    report.atomCount, report.sampleCount, signature,
  );
  const receipt = await tx.wait();
  const code = await provider.getCode(await deployed.getAddress());
  const target = new JsonRpcProvider('https://robinhood.rpc.pinax.network');
  const targetDeploy = await factory.getDeployTransaction(await operator.getAddress());
  const [targetChain, targetFees, targetDeploymentEstimate] = await Promise.all([
    target.getNetwork(), target.getFeeData(),
    target.estimateGas({ from: await operator.getAddress(), data: targetDeploy.data }),
  ]);
  await target.destroy();
  const combinedProjectedGas = Number(targetDeploymentEstimate + receipt.gasUsed);
  const observedGasPriceWei = Number(targetFees.gasPrice);
  const ethUsd = 2281.33; // Dated illustrative assumption, not a live market quote.
  const usdAt = weiPerGas => combinedProjectedGas * weiPerGas / 1e18 * ethUsd;
  const result = {
    status: 'measured_local_evm',
    targetChainId: 4663,
    localEvm: 'Ganache Shanghai; exact target-client gas and L1 data fees may differ',
    compiler: solc.version(),
    optimizerRuns: 200,
    runtimeBytes: (code.length - 2) / 2,
    initcodeBytes: artifact.evm.bytecode.object.length / 2,
    deploymentGas: String(deploymentReceipt.gasUsed),
    firstAnchorTransactionGas: String(receipt.gasUsed),
    combinedGas: String(deploymentReceipt.gasUsed + receipt.gasUsed),
    firstAnchorEvent: receipt.logs.length > 0,
    targetReadOnlyPreflight: {
      chainId: String(targetChain.chainId),
      gasPriceWei: String(targetFees.gasPrice),
      deploymentEstimateGas: String(targetDeploymentEstimate),
      transactionSent: false,
      scope: 'Read-only Robinhood Chain creation eth_estimateGas; may include target L1 data allocation. The anchor call has only local-EVM gas, so its target execution and L1 allocation are unmeasured.',
    },
    budgetEstimate: {
      kind: 'Mixed target-creation estimate plus local anchor execution; not an all-in target fee quote.',
      budgetCapGuaranteed: false,
      projectedGas: String(combinedProjectedGas),
      firstTransactionGas: String(receipt.gasUsed),
      deploymentGas: String(targetDeploymentEstimate),
      ethUsd: { value: ethUsd, asOf: '2026-11-02', kind: 'illustrative_assumption', note: 'No live market price provenance is claimed.' },
      currentGasPriceFeeUsd: Number(usdAt(observedGasPriceWei.toString())),
      stress100GweiFeeUsd: Number(usdAt(100_000_000_000)),
      stress200GweiFeeUsd: Number(usdAt(200_000_000_000)),
      excludes: ['Unmeasured target anchor execution and anchor-call L1 data allocation', 'wallet or relayer charges', 'future fee or ETH price movements'],
    },
    cryptographicScope: 'EIP-712 operator signature over input, method, settings, output, atom count and sample count; no molecular computation is verified on-chain.',
    mainnetTransactionsSent: 0,
  };
  fs.writeFileSync(new URL('./budget-measurement.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await raw.disconnect();
}
