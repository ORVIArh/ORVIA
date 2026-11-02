// Read-only target-provider creation probe. No signing or send method exists.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]||'.');
const inputFile=path.resolve(process.argv[3]||'deployment-runtime-input.json');
const outputFile=path.resolve(process.argv[4]||'target-256-creation-probe.json');
const require=createRequire(path.join(root,'package.json'));
const {keccak256,isAddress}=require('ethers');
const sha=value=>createHash('sha256').update(value).digest('hex');
const must=(ok,message)=>{if(!ok)throw Error(message);};
const binary=value=>typeof value==='string'&&/^0x(?:[a-fA-F0-9]{2})+$/.test(value);
const endpoint='https://robinhood.rpc.pinax.network';
const allowed=Object.freeze(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getTransactionCount','eth_call']);
const sender='0x0000000000000000000000000000000000009000';
const calls=[];let sequence=0;
const report={status:'incomplete',passed:false,startedAt:new Date().toISOString(),
  scope:'Provider-observed read-only creation of the two large ORVIA coordinators with temporary dependency code overrides.',
  targetChainId:4663,provider:endpoint,providerSource:'https://docs.robinhood.com/chain/connecting/',
  allowedMethods:allowed,mainnetTransactionsSent:0,noSignerOrKeyLoaded:true,scientificModelAccepted:false,readyForMainnet:false,
  scriptSha256:sha(fs.readFileSync(import.meta.filename)),creationChecks:[],calls,
  limitations:['Runtime inputs come from the recorded local fixture; this probe does not independently compile them.',
    'Only dependency runtime code is overridden; storage is not transplanted. Constructor dependencies requiring stored values can make a probe inconclusive.',
    'eth_call is ephemeral and can use simulation-specific gas rules; success does not establish transaction admission, fees or sustained execution.',
    'Provider responses are trusted observations, not independently verified state proofs.',
    'No complete molecular trajectory, scientific acceptance or persistent deployment is established.']};
const save=()=>{fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n');};
save();
async function rpc(method,params=[]){
  must(allowed.includes(method),'Method outside fixed read-only allowlist');
  const payload={jsonrpc:'2.0',id:++sequence,method,params};
  const row={id:payload.id,method,requestSha256:sha(JSON.stringify(payload))};calls.push(row);
  const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  row.httpStatus=response.status;must(response.ok,'RPC HTTP '+response.status);
  const raw=await response.text();must(raw.length<3_000_000,'Oversized response');row.responseSha256=sha(raw);
  const body=JSON.parse(raw);must(body.id===payload.id&&body.jsonrpc==='2.0','RPC identity mismatch');
  if(body.error){row.error={code:body.error.code,message:String(body.error.message).slice(0,350)};throw Error(method+': '+row.error.message);}
  must(Object.hasOwn(body,'result'),'RPC result absent');row.returned=true;return body.result;
}
try{
  const bytes=fs.readFileSync(inputFile),input=JSON.parse(bytes);report.inputSha256=sha(bytes);report.inputFile=path.basename(inputFile);
  must(Array.isArray(input.core)&&input.core.length===32,'Expected exactly 32 core deployment records');
  must(new Set(input.core.map(x=>x.address.toLowerCase())).size===32,'Core addresses not unique');
  for(const name of ['MolecularSimulationPipeline','AlchemicalHamiltonianEvaluator'])must(input.core.filter(x=>x.contract===name).length===1,'Expected exactly one '+name);
  must(input.compilation&&input.compilation.compiler==='0.8.26+commit.8a97fa7a.Emscripten.clang','Missing pinned compilation provenance');
  must(Object.keys(input.compilation.sourceSha256||{}).length>20&&Object.values(input.compilation.sourceSha256).every(x=>/^[a-f0-9]{64}$/.test(x)),'Malformed compilation source hashes');
  const overrides={};
  for(const row of input.core){
    must(isAddress(row.address)&&binary(row.runtimeCode)&&binary(row.creationData),'Malformed deployment input');
    must(keccak256(row.runtimeCode)===row.runtimeKeccak256,'Runtime hash mismatch');
    overrides[row.address]={code:row.runtimeCode};
  }
  report.compilation=input.compilation;
  report.dependencyRuntimes=input.core.map(x=>({contract:x.contract,address:x.address,runtimeKeccak256:x.runtimeKeccak256,bytes:(x.runtimeCode.length-2)/2}));
  must(BigInt(await rpc('eth_chainId'))===4663n,'Wrong target chain');
  const block=await rpc('eth_getBlockByNumber',['latest',false]);
  must(block&&/^0x[0-9a-f]+$/i.test(block.number)&&/^0x[0-9a-f]{64}$/i.test(block.hash)&&/^0x[0-9a-f]{64}$/i.test(block.stateRoot),'Invalid block');
  report.block={number:block.number,hash:block.hash,stateRoot:block.stateRoot,timestamp:block.timestamp,gasLimit:block.gasLimit};save();
  const nonce=await rpc('eth_getTransactionCount',[sender,block.number]);report.senderNonce=nonce;
  // Confirm the fixture's random addresses are empty at the pinned target state.
  for(let offset=0;offset<input.core.length;offset+=4){
    const rows=input.core.slice(offset,offset+4);
    const codes=await Promise.all(rows.map(row=>rpc('eth_getCode',[row.address,block.number])));
    for(let k=0;k<rows.length;k++)must(codes[k]==='0x','Fixture address is occupied on target; refusing override');
  }
  for(const name of ['MolecularSimulationPipeline','AlchemicalHamiltonianEvaluator']){
    const item=input.core.find(x=>x.contract===name);must(item,'Missing coordinator '+name);
    const check={contract:name,creationBytes:(item.creationData.length-2)/2,creationKeccak256:keccak256(item.creationData),
      expectedRuntimeBytes:(item.runtimeCode.length-2)/2,expectedRuntimeKeccak256:item.runtimeKeccak256,status:'incomplete'};
    report.creationChecks.push(check);save();
    try{
      const returned=await rpc('eth_call',[{from:sender,gas:'0x1c9c380',gasPrice:'0x0',value:'0x0',data:item.creationData},block.number,overrides]);
      must(binary(returned),'Missing creation runtime');check.returnedRuntimeBytes=(returned.length-2)/2;check.returnedRuntimeKeccak256=keccak256(returned);
      check.exactRuntimeMatch=returned.toLowerCase()===item.runtimeCode.toLowerCase();must(check.exactRuntimeMatch,'Creation runtime differs');check.status='passed';
    }catch(error){check.status='failed_or_unsupported';check.error=String(error.message).slice(0,500);}
    save();
  }
  const recheck=await rpc('eth_getBlockByNumber',[block.number,false]);
  must(recheck.hash===block.hash&&recheck.stateRoot===block.stateRoot,'Pinned block changed');report.pinnedBlockUnchanged=true;
  report.passed=report.creationChecks.every(x=>x.status==='passed');report.status=report.passed?'passed_read_only_creation':'partial_or_unsupported';
}catch(error){report.status='failed_or_inconclusive';report.error=String(error.message).slice(0,500);}
finally{report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,checks:report.creationChecks,report:outputFile,mainnetTransactionsSent:0}));if(!report.passed)process.exitCode=1;}
