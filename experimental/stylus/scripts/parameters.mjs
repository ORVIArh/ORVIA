import fs from 'node:fs';
import { Interface } from 'ethers';
const rpcUrl='https://robinhood.rpc.pinax.network';
const allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_call']);
let serial=0;
const requests=[];
async function rpc(method,params=[]){
 if(!allowed.has(method))throw new Error('Read-only method refused');
 const id=++serial;
 const response=await fetch(rpcUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 const value=await response.json();requests.push({method,id,error:value.error??null});
 if(value.id!==id||value.jsonrpc!=='2.0'||value.error)throw new Error(value.error?.message??'Invalid response');
 return value.result;
}
const report={status:'in_progress',mainnetTransactionsSent:0,checks:[],requests};
fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/stylus_parameters.json',JSON.stringify(report,null,2)+'\n');
try{
 const chain=await rpc('eth_chainId');if(BigInt(chain)!==4663n)throw new Error('Wrong target');
 const block=await rpc('eth_getBlockByNumber',['latest',false]);report.referenceBlock={number:block.number,hash:block.hash,stateRoot:block.stateRoot};
 const a='0x0000000000000000000000000000000000000071';
 for(const [fn,type]of[['stylusVersion','uint16'],['inkPrice','uint32'],['maxStackDepth','uint32'],['expiryDays','uint16'],['keepaliveDays','uint16']]){
  const iface=new Interface([`function ${fn}() view returns (${type})`]);
  const row={function:fn,status:'unknown'};report.checks.push(row);
  try{const output=await rpc('eth_call',[{to:a,data:iface.encodeFunctionData(fn)},block.number]);row.value=String(iface.decodeFunctionResult(fn,output)[0]);row.status='returned';}catch(e){row.status='failed_or_unsupported';row.error=e.message;}
 }
 const again=await rpc('eth_getBlockByNumber',[block.number,false]);if(again.hash!==block.hash)throw new Error('Reference block changed');
 report.status=report.checks.find(r=>r.function==='stylusVersion')?.status==='returned'?'stylus_parameters_observed':'inconclusive';
}catch(e){report.status='failed_or_inconclusive';report.error=e.message;process.exitCode=2;}
report.checkedAtUtc=new Date().toISOString();fs.writeFileSync('reports/stylus_parameters.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
