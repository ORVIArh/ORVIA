// Prepares an unsigned, short-lived deployment package. No broadcast or wallet key API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); return i<0 ? undefined : args[i+1]; };
assert(args.length === 6 && args.filter(x=>x.startsWith('--')).sort().join() === '--operator,--out,--sender',
  'Usage: node prepare_deployment.mjs --operator 0x... --sender 0x... --out /absolute/directory');
let operator = option('--operator');
let sender = option('--sender');
const directory = option('--out'); assert(path.isAbsolute(directory), 'Output directory must be absolute');
fs.mkdirSync(directory, { recursive: true });
const planPath = path.join(directory, 'unsigned-deployment.json');
const plan = { status: 'incomplete', broadcast: false, chainId: 4663, operator, proposedSender: sender,
  createdAtUtc: new Date().toISOString(), requiresWalletApproval: true, requests: [],
  scientificResultAccepted: false, firstReportTransactionPrepared: false };
const save = () => fs.writeFileSync(planPath, JSON.stringify(plan,null,2)+'\n'); save();
const ENDPOINT = 'https://robinhood.rpc.pinax.network';
const allowed = new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getBalance',
  'eth_getTransactionCount','eth_gasPrice','eth_estimateGas','eth_call']);
let serial=0;
async function rpc(method,params=[]) {
  assert(allowed.has(method), 'Method outside read-only allowlist');
  const payload={jsonrpc:'2.0',id:++serial,method,params};
  const response=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(20000)});
  assert(response.ok,`RPC HTTP ${response.status}`);
  const text=await response.text();assert(text.length<1_000_000);
  plan.requests.push({method,requestSha256:sha(JSON.stringify(payload)),responseSha256:sha(text)});
  const value=JSON.parse(text); assert.equal(value.id,payload.id); assert.equal(value.jsonrpc,'2.0');
  assert(!value.error, value.error?.message);assert(Object.hasOwn(value,'result'));return value.result;
}
try {
  const [{default:solc},{getAddress,getCreateAddress,keccak256,toBeHex,Interface}] = await Promise.all([import('solc'),import('ethers')]);
  operator=getAddress(operator);sender=getAddress(sender);
  assert(operator !== '0x0000000000000000000000000000000000000000');
  plan.operator=operator;plan.proposedSender=sender;
  const source=fs.readFileSync(new URL('./ORVIAResultAnchor.sol',import.meta.url),'utf8');
  const scriptHash=sha(fs.readFileSync(import.meta.filename));
  const lockHash=sha(fs.readFileSync(new URL('../../package-lock.json',import.meta.url)));
  const validation=JSON.parse(fs.readFileSync(new URL('./validation-report.json',import.meta.url),'utf8'));
  assert.equal(validation.passed,true,'Focused contract validation must pass');
  assert.equal(validation.sourceSha256,sha(source),'Validation belongs to another source');
  assert.equal(validation.scriptSha256,sha(fs.readFileSync(new URL('./validate.mjs',import.meta.url))), 'Validator changed since validation');
  assert.equal(validation.dependencyLockSha256,lockHash,'Dependency lock changed since validation');
  assert(solc.version().startsWith('0.8.26+'),'Unexpected compiler');
  const input={language:'Solidity',sources:{'ORVIAResultAnchor.sol':{content:source}},settings:{
    optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input)));
  assert(!output.errors?.some(e=>e.severity==='error'),'Compilation failed');
  const a=output.contracts['ORVIAResultAnchor.sol'].ORVIAResultAnchor;
  const iface=new Interface(a.abi);
  const data='0x'+a.evm.bytecode.object+iface.encodeDeploy([operator]).slice(2);
  let expected=a.evm.deployedBytecode.object;
  for(const refs of Object.values(a.evm.deployedBytecode.immutableReferences))for(const ref of refs){
    assert.equal(ref.length,32);expected=expected.slice(0,ref.start*2)+operator.slice(2).toLowerCase().padStart(64,'0')+expected.slice((ref.start+ref.length)*2);
  }
  expected='0x'+expected;
  assert.equal(BigInt(await rpc('eth_chainId')),4663n,'Wrong chain');
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  const nonce=await rpc('eth_getTransactionCount',[sender,block.number]);
  assert.equal(await rpc('eth_getTransactionCount',[sender,'pending']),nonce,'Pending sender transaction; refresh plan after it resolves');
  const address=getCreateAddress({from:sender,nonce:BigInt(nonce)});
  assert.equal(await rpc('eth_getCode',[address,block.number]),'0x','Predicted deployment address already has code');
  assert.equal(await rpc('eth_getCode',[operator,block.number]),'0x','This package supports a plain EOA operator');
  assert.equal(await rpc('eth_getCode',[sender,block.number]),'0x','This package supports a plain EOA deployer');
  const tx={from:sender,data,value:'0x0',nonce};
  const returned=await rpc('eth_call',[{...tx,gas:'0x989680',gasPrice:'0x0'},block.number]);
  assert.equal(returned.toLowerCase(),expected.toLowerCase(),'Exact operator-bound runtime mismatch');
  const operatorResult=await rpc('eth_call',[{to:address,data:iface.encodeFunctionData('operator')},block.number,{[address]:{code:returned}}]);
  assert.equal(getAddress(iface.decodeFunctionResult('operator',operatorResult)[0]),operator);
  const estimate=BigInt(await rpc('eth_estimateGas',[tx,block.number]));
  const price=BigInt(await rpc('eth_gasPrice'));assert(estimate>21000n&&price>0n);
  const gasLimit=(estimate*125n+99n)/100n,maxFee=price*2n;
  const maximumFee=gasLimit*maxFee,allocation=10n**16n;
  assert(maximumFee<=allocation,'Deployment exceeds its 0.01 ETH budget allocation');
  const funded=BigInt(await rpc('eth_getBalance',[sender,block.number]))>=maximumFee;
  assert(funded,'Sender needs enough balance for the prepared maximum deployment fee');
  const again=await rpc('eth_getBlockByNumber',[block.number,false]);assert.equal(again.hash,block.hash);
  assert.equal(await rpc('eth_getTransactionCount',[sender,'pending']),nonce,'Sender nonce changed while preparing');
  assert.equal(sha(fs.readFileSync(new URL('./ORVIAResultAnchor.sol',import.meta.url))),sha(source),'Source changed during preparation');
  assert.equal(sha(fs.readFileSync(import.meta.filename)),scriptHash,'Preparation script changed during run');
  assert.equal(sha(fs.readFileSync(new URL('../../package-lock.json',import.meta.url))),lockHash,'Dependency lock changed during preparation');
  Object.assign(plan,{status:'prepared_unsigned',expiresAtUtc:new Date(Date.now()+15*60*1000).toISOString(),
    endpoint:ENDPOINT,referenceBlock:{number:block.number,hash:block.hash},predictedContractAddress:address,
    compiler:solc.version(),sourceSha256:sha(source),scriptSha256:sha(fs.readFileSync(import.meta.filename)),
    dependencyLockSha256:sha(fs.readFileSync(new URL('../../package-lock.json',import.meta.url))),
    validationReportSha256:sha(fs.readFileSync(new URL('./validation-report.json',import.meta.url))),
    standardInputSha256:sha(JSON.stringify(input)),creationKeccak256:keccak256(data),runtimeKeccak256:keccak256(returned),
    targetCreationEstimateGas:String(estimate),observedGasPriceWei:String(price),
    estimatedNetworkFeeWei:String(estimate*price),maximumDeploymentNetworkFeeWei:String(maximumFee),
    deploymentAllocationWei:String(allocation),firstReportAllocationWei:String(allocation),
    totalNetworkBudgetWei:String(allocation*2n),conditionalUsdBudget:{cap:200,ethUsdCeiling:10000,liveMarketClaim:false},
    senderCanCoverPreparedMaximumFee:funded,
    transaction:{...tx,type:'0x2',chainId:'0x1237',gas:toBeHex(gasLimit),maxFeePerGas:toBeHex(maxFee),maxPriorityFeePerGas:'0x0'},
    walletReview:['Confirm chain 4663, proposed sender, operator and zero value','Refresh if this plan expired or sender nonce/fee conditions changed',
      'This transaction deploys an attestation log only; it publishes no scientific result','Only the wallet holder can approve/sign; this tool has no broadcast method'],
    finalReportPending:['Actual artifact bundle with honest scientific status and durable availability','EIP-712 report signature from the operator',
      'Exact report-call target estimate within the remaining budget'],
  });
  fs.writeFileSync(path.join(directory,'compiler-standard-input.json'),JSON.stringify(input,null,2)+'\n');
  fs.writeFileSync(path.join(directory,'contract-abi.json'),JSON.stringify(a.abi,null,2)+'\n');
  fs.writeFileSync(path.join(directory,'expected-runtime.hex'),returned+'\n');
}catch(e){plan.status='blocked';plan.error=e.message;process.exitCode=2;}
finally{save();}
console.log(JSON.stringify({status:plan.status,operator:plan.operator,predictedContractAddress:plan.predictedContractAddress,
  maximumDeploymentNetworkFeeWei:plan.maximumDeploymentNetworkFeeWei,output:planPath,error:plan.error}));
