import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import solc from 'solc';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

export function compile() {
  const sourceFiles = [...walk('contracts'), ...(fs.existsSync('test/contracts') ? walk('test/contracts') : [])];
  const sources = Object.fromEntries(sourceFiles.filter(p => p.endsWith('.sol')).sort()
    .map(p => [p, { content: fs.readFileSync(p, 'utf8') }]));
  if (!Object.keys(sources).length) throw new Error('No Solidity sources');
  const settings = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings })));
  for (const e of output.errors ?? []) {
    if (e.severity === 'error') process.stderr.write(e.formattedMessage);
  }
  if ((output.errors ?? []).some(e => e.severity === 'error')) throw new Error('Solidity compilation failed');
  const artifacts = {};
  const sizes = [];
  for (const [file, contracts] of Object.entries(output.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      const runtimeBytes = c.evm.deployedBytecode.object.length / 2;
      const creationBytes = c.evm.bytecode.object.length / 2;
      const testOnly = file.startsWith('test/');
      artifacts[name] = { source: file, testOnly, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object,
        deployedBytecode: '0x' + c.evm.deployedBytecode.object };
      sizes.push({ name, file, testOnly, creationBytes, runtimeBytes,
        fitsDocumentedRobinhoodCodeLimit: runtimeBytes <= 96 * 1024,
        creationCodeWithinDocumentedInitLimit: creationBytes <= 192 * 1024 });
    }
  }
  const report = {
    compiler: solc.version(), settings,
    scope: 'Experimental molecular numerics, alternative resumable dynamics and analysis components; no integrated production RBFE system, mainnet deployment or complete 64-slot implementation.',
    targetChainId: 4663,
    documentedLimitsSource: 'https://docs.robinhood.com/chain/differences-from-ethereum/',
    constructorArgumentsIncludedInSizes: false,
    sources: Object.fromEntries(Object.entries(sources).map(([p, s]) => [p,
      crypto.createHash('sha256').update(s.content).digest('hex')])),
    contracts: sizes,
    warnings: (output.errors ?? []).filter(e => e.severity !== 'error').map(e => e.formattedMessage)
  };
  fs.mkdirSync('build', { recursive: true });
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('build/artifacts.json', JSON.stringify(artifacts, null, 2) + '\n');
  fs.writeFileSync('reports/compiled_sizes.json', JSON.stringify(report, null, 2) + '\n');
  return { artifacts, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/compile.mjs')) {
  const { report } = compile();
  console.log(JSON.stringify({ compiler: report.compiler, contracts: report.contracts }, null, 2));
}
