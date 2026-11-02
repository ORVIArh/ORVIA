import { spawnSync } from 'node:child_process';

// The source audit needs only the standard library. Actual native-model tests
// use their separately pinned OpenMM/RDKit preparation environment.
const python=process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3';
const preparationPython=process.env.ORVIA_PREPARATION_PYTHON||'python3';
for(const [command,args]of [
  [python,['scripts/audit_preparation.py','--check','--self-test']],
  [preparationPython,['-m','unittest','discover','-s','test/preparation','-p','test_*.py','-v']]
]){
  const result=spawnSync(command,args,{stdio:'inherit'});
  if(result.error)console.error(result.error.message);
  if(result.status!==0||result.error){
    console.error('Preparation validation failed. Set ORVIA_PREPARATION_PYTHON to the separate pinned preparation environment described in docs/LIGAND_PREPARATION_v0_1.md.');
    process.exitCode=1;break;
  }
}
