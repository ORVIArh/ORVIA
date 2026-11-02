// One local unlock connects reviewed diagnostic artifacts to the deployed registry.
// Importing this module never reads a wallet or RPC configuration.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Transaction,keccak256,formatEther,toQuantity} from 'ethers';
import {prepareOperation,verifyOperation,readVerifiedState,registrationActions,reportForState,verifySignedReport} from './report_operator.mjs';
import {domain,REPORT_TYPES,reportDigest} from './attestation.mjs';
import {measureConnection} from './connect_gpu_cost.mjs';
import {deploymentRpc,confirmedReceipt,reconcileSignedEntry,readDeploymentJournal,validateSignedEntry} from '../deployment/hybrid_operator_market.mjs';
import {marketQuote,feeEvidence} from '../deployment/market_recovery.mjs';
import {walletLocation,secureDirectory,readPrivateFile,decryptVerified,withHiddenSession,hiddenPrompt,SafeError} from '../../experimental/mainnet-lite/local_wallet.mjs';

const GAS_CAP=1000000n,CHAIN=4663,COORDINATOR='0x3B188B4c5B76b009d80455D3bbB7597983E390f0',OWNER='0x2541a9e93B5C853E9208b0C5C7386dD458424c77';
const ACTIONS=['registerExperiment','startRun','submitReport'];
const CODE=['connect_gpu.mjs','connect_gpu_cost.mjs','../deployment/hybrid_operator_market.mjs','../deployment/market_recovery.mjs'];
const hash=x=>createHash('sha256').update(x).digest('hex');
const plain=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
const canonical=x=>{if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);};
const must=(ok,message)=>{if(!ok)throw new SafeError(message);};
const quantity=x=>{must(typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x),'Invalid RPC quantity.');return BigInt(x);};
const decimal=x=>{must(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x),'Invalid decimal gas quantity.');return BigInt(x);};
function sources(){return Object.fromEntries(CODE.map(name=>[name,hash(fs.readFileSync(new URL(name,import.meta.url)))]));}
function readJson(file){const fd=fs.openSync(path.resolve(file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);must(s.isFile()&&s.size>0&&s.size<=16*1024*1024,'Invalid public JSON input.');return JSON.parse(fs.readFileSync(fd));}finally{fs.closeSync(fd);}}
function atomicJson(file,data){const full=path.resolve(file),temporary=full+'.tmp-'+process.pid,fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify(plain(data),null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,full);const parent=fs.openSync(path.dirname(full),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}

export async function prepareConnection(options){
  const operationPlan=prepareOperation(options),context=verifyOperation(operationPlan,operationPlan.planSha256);
  must(context.plan.coordinator===COORDINATOR&&context.spec.owner===OWNER&&context.spec.operator===OWNER,'Unexpected mainnet coordinator or operator.');
  must(context.assessment.diagnosticOnly===true,'This connection accepts reviewed diagnostics only.');
  const before=sources(),localMeasurements=await measureConnection(context);
  for(const name of ACTIONS)must(decimal(localMeasurements.gas[name])>21000n&&decimal(localMeasurements.gas[name])<=GAS_CAP,'Local action exceeds connection gas policy.');
  must(canonical(before)===canonical(sources()),'Connection source changed while preparing.');
  verifyOperation(operationPlan,operationPlan.planSha256);
  const body={schema:'orvia.hybrid-gpu-connection-plan.v1',createdAtUtc:new Date().toISOString(),chainId:CHAIN,coordinator:context.plan.coordinator,runId:context.plan.runId,diagnosticOnly:true,totalTransactions:3,operationPlan,operationPlanSha256:operationPlan.planSha256,localMeasurements,sourceSha256:before,trust:'Operator attestation to reviewed GPU diagnostic artifacts; no proof of scientific correctness'};
  return {...body,planSha256:hash(canonical(body))};
}
export function verifyConnection(plan,approved){
  const {planSha256,...body}=plan;
  must(plan.schema==='orvia.hybrid-gpu-connection-plan.v1'&&planSha256===approved&&hash(canonical(body))===approved,'Connection plan hash mismatch.');
  must(plan.chainId===CHAIN&&plan.coordinator===COORDINATOR&&plan.totalTransactions===3&&plan.diagnosticOnly===true,'Unexpected connection scope.');
  must(canonical(plan.sourceSha256)===canonical(sources()),'Connection implementation changed.');
  const context=verifyOperation(plan.operationPlan,plan.operationPlanSha256);
  must(context.plan.runId===plan.runId&&context.plan.coordinator===plan.coordinator&&context.spec.sender===OWNER&&context.spec.operator===OWNER&&context.assessment.diagnosticOnly===true,'Operation differs from connection plan.');
  for(const name of ACTIONS)must(decimal(plan.localMeasurements.gas[name])>21000n&&decimal(plan.localMeasurements.gas[name])<=GAS_CAP,'Invalid local measurement.');
  return context;
}
function environment(){const location=walletLocation(),directory=path.join(location.home,'.orvia','hybrid-connections'),locks=path.join(location.home,'.orvia','deployments'),rpcDirectory=path.join(location.home,'.orvia','rpc');secureDirectory(location.home,location.directory);secureDirectory(location.home,directory,true);secureDirectory(location.home,locks,true);secureDirectory(location.home,rpcDirectory);return{...location,directory,locks,rpc:deploymentRpc(readPrivateFile(path.join(rpcDirectory,'robinhood-mainnet-alchemy.url')).trim())};}
export function validateConnectionJournal(file,plan,context){
  if(!fs.existsSync(file))return{schema:'orvia.gpu-connection-journal.v1',planSha256:plan.planSha256,operationPlanSha256:plan.operationPlanSha256,chainId:CHAIN,coordinator:plan.coordinator,runId:plan.runId,sender:context.spec.sender,actions:{},signedReport:null,complete:false};
  const j=readDeploymentJournal(file);
  must(j.schema==='orvia.gpu-connection-journal.v1'&&j.planSha256===plan.planSha256&&j.operationPlanSha256===plan.operationPlanSha256&&j.sender===context.spec.sender&&j.coordinator===plan.coordinator&&j.runId===plan.runId&&j.chainId===CHAIN&&typeof j.complete==='boolean','Private connection journal differs from plan.');
  must(j.actions&&Object.keys(j.actions).every(x=>ACTIONS.includes(x)),'Invalid journal actions.');
  if(j.signedReport)verifySignedReport(context,j.signedReport);
  for(const name of Object.keys(j.actions)){
    const saved=j.actions[name];
    let data;
    if(name==='submitReport'){must(j.signedReport,'Submitted action lacks reviewed report.');const report=verifySignedReport(context,j.signedReport);data=context.api.encodeFunctionData('submitReport',[report,j.signedReport.signature]);}
    else data=registrationCalldata(context,name);
    const expected={from:context.spec.sender,to:plan.coordinator,value:'0x0',data,nonce:saved.intended?.nonce};
    quantity(expected.nonce);
    must(canonical(saved.intended)===canonical(expected),'Saved action differs from approved calldata or sender.');
    const tx=validateSignedEntry(saved.entry,expected,context.spec.sender);
    must(tx.gasLimit<=GAS_CAP&&tx.gasPrice>0n,'Saved action violates fee policy.');
    const e=saved.entry.feeEvidence;
    must(e?.schema==='orvia.live-market-fee.v1'&&e.kind==='new_nonce'&&e.inclusionMarginPercent===25&&decimal(e.chosenPriceWei)===tx.gasPrice,'Saved fee evidence differs from signature.');
    const market=decimal(e.observedPriceWei)>decimal(e.baseFeeWei)?decimal(e.observedPriceWei):decimal(e.baseFeeWei);
    must(market===decimal(e.marketPriceWei)&&tx.gasPrice===(market*125n+99n)/100n,'Saved live-market margin is invalid.');
  }
  const fees=connectionActualFee(j);must(!j.complete||fees.count===3,'Complete journal lacks three receipts.');return j;
}

export function connectionActualFee(journal){let fee=0n,count=0;for(const name of ACTIONS){const a=journal.actions[name];if(!a?.receipt)continue;const r=a.receipt,tx=validateSignedEntry(a.entry,a.intended,a.intended.from);const used=quantity(r.gasUsed),price=quantity(r.effectiveGasPrice);must(r.transactionHash===a.entry.transactionHash&&quantity(r.status)===1n&&used>0n&&used<=tx.gasLimit&&price>0n&&price<=tx.gasPrice,'Journal receipt fee/identity invalid.');fee+=used*price;count++;}return{fee,count};}
export function connectionProgress(plan,stage,journal,preflight,extra={}){const {fee,count}=connectionActualFee(journal);return{schema:'orvia.hybrid-gpu-connection-progress.v1',planSha256:plan.planSha256,coordinator:plan.coordinator,runId:plan.runId,diagnosticOnly:true,confirmedTransactions:count,totalTransactions:3,totalFeeEstimateEth:preflight?.totalFeeEstimateEth??'0',feeReserveEth:preflight?.feeReserveEth??'0',totalActualFeeEth:formatEther(fee),estimateScope:'Confirmed actual fees plus a fresh target first remaining call and conditional local later calls; reserve is1Mgas per remaining call at fresh market plus25%.',stage,errorCode:null,...extra,complete:stage==='complete'&&count===3&&!extra.errorCode,totalTransactions:3};}
export async function preflightConnection(plan,approved,rpc,journal){
  const context=verifyConnection(plan,approved),state=await readVerifiedState(context,rpc);
  const quote=await marketQuote(rpc),evidence=feeEvidence(quote,'new_nonce'),price=decimal(evidence.chosenPriceWei);
  const actions=registrationActions(context,state);
  let firstTargetEstimate=null;
  if(actions.length){const gas=quantity(await rpc('eth_estimateGas',[{from:context.spec.sender,to:plan.coordinator,value:'0x0',data:actions[0].data,gasPrice:toQuantity(price)},'pending']));must(gas>21000n&&((gas*125n+99n)/100n)<=GAS_CAP,'First target action exceeds gas policy.');firstTargetEstimate={action:actions[0].name,gasIncludingL1:gas.toString()};}
  const confirmed=connectionActualFee(journal);
  const remaining=ACTIONS.filter(name=>!journal.actions[name]?.receipt);
  let estimatedGas=0n;
  for(const name of remaining){const gas=firstTargetEstimate?.action===name?BigInt(firstTargetEstimate.gasIncludingL1):decimal(plan.localMeasurements.gas[name]);estimatedGas+=(gas*125n+99n)/100n;}
  const reserve=GAS_CAP*BigInt(remaining.length)*price,balance=quantity(await rpc('eth_getBalance',[context.spec.sender,'pending']));
  must(balance>=reserve,'Balance does not cover conservative remaining-action reserve.');
  must(await rpc('eth_getCode',[context.spec.sender,'pending'])==='0x','Sender is not an EOA.');
  verifyConnection(plan,approved);
  return{context,state,quote,chosenGasPriceWei:price.toString(),firstTargetEstimate,totalFeeEstimateEth:formatEther(confirmed.fee+estimatedGas*price),feeReserveEth:formatEther(reserve),balanceWei:balance.toString(),conditionalLocalEstimates:true,thirdTargetEstimateRequiresActualOperatorSignature:true};
}
export function registrationCalldata(context,name){if(name==='registerExperiment')return context.api.encodeFunctionData(name,[context.assessment.experimentId,context.assessment.configuration]);if(name==='startRun')return context.api.encodeFunctionData(name,[context.assessment.experimentId,context.plan.runId,context.assessment.runConfigHash,context.assessment.checkpointHash]);throw new SafeError('Unknown registration action.');}
async function sendAction({plan,approved,context,rpc,wallet,journal,journalFile,name,data}){
  const intended={from:context.spec.sender,to:plan.coordinator,value:'0x0',data};
  const beforeRetransmit=async()=>{verifyConnection(plan,approved);await readVerifiedState(context,rpc);};
  if(journal.actions[name]){
    const saved=journal.actions[name];must(canonical(saved.intended)===canonical({...intended,nonce:saved.intended.nonce}),'Saved action differs from intent.');
    const tx=validateSignedEntry(saved.entry,saved.intended,context.spec.sender);must(tx.gasLimit<=GAS_CAP,'Saved action exceeds gas cap.');
    saved.receipt=await reconcileSignedEntry(saved.entry,saved.intended,context.spec.sender,rpc,beforeRetransmit);atomicJson(journalFile,journal);return saved.receipt;
  }
  verifyConnection(plan,approved);await readVerifiedState(context,rpc);
  const nonce=quantity(await rpc('eth_getTransactionCount',[context.spec.sender,'pending']));must(nonce<=BigInt(Number.MAX_SAFE_INTEGER),'Sender nonce exceeds safe signing range.');
  const evidence=feeEvidence(await marketQuote(rpc),'new_nonce'),price=decimal(evidence.chosenPriceWei);
  const estimate=quantity(await rpc('eth_estimateGas',[{...intended,nonce:toQuantity(nonce),gasPrice:toQuantity(price)},'pending'])),limit=(estimate*125n+99n)/100n,block=await rpc('eth_getBlockByNumber',['latest',false]);
  must(estimate>21000n&&limit<=GAS_CAP&&limit<=quantity(block.gasLimit),'Action exceeds gas policy.');
  must(quantity(await rpc('eth_getBalance',[context.spec.sender,'pending']))>=limit*price,'Balance does not cover this live action.');
  const raw=await wallet.signTransaction({type:0,chainId:CHAIN,nonce:Number(nonce),to:plan.coordinator,value:0n,data,gasLimit:limit,gasPrice:price});
  const entry={rawTransaction:raw,transactionHash:keccak256(raw),gasLimit:limit.toString(),gasPriceWei:price.toString(),feeEvidence:evidence},exact={...intended,nonce:toQuantity(nonce)};
  validateSignedEntry(entry,exact,context.spec.sender);journal.actions[name]={intended:exact,entry,receipt:null};atomicJson(journalFile,journal);
  await beforeRetransmit();must(quantity(await rpc('eth_chainId'))===BigInt(CHAIN)&&quantity(await rpc('eth_getTransactionCount',[context.spec.sender,'pending']))===nonce,'Chain or nonce changed after signature; journal retained.');
  must(await rpc('eth_sendRawTransaction',[raw])===entry.transactionHash,'Broadcast hash mismatch.');
  journal.actions[name].receipt=await confirmedReceipt(entry.transactionHash,rpc);atomicJson(journalFile,journal);return journal.actions[name].receipt;
}
export async function executeConnection({plan,approved,context,rpc,wallet,journal,journalFile,progressFile,preflight}){
  const progress=stage=>atomicJson(progressFile,connectionProgress(plan,stage,journal,preflight));
  for(const name of ['registerExperiment','startRun']){
    progress(name==='registerExperiment'?'registering_experiment':'starting_run');
    const state=await readVerifiedState(context,rpc),action=registrationActions(context,state).find(a=>a.name===name);
    if(action||journal.actions[name]){
      const data=registrationCalldata(context,name);
      if(action)must(action.data===data,'Registration encoding differs from approved context.');
      await sendAction({plan,approved,context,rpc,wallet,journal,journalFile,name,data});
    } else throw new SafeError('Expected registration transaction is not in this connection journal.');
    verifyConnection(plan,approved);
  }
  progress('signing_report');let state=await readVerifiedState(context,rpc);
  if(!journal.signedReport){const message=reportForState(context,state,BigInt(state.block.timestamp)+3600n),signature=await wallet.signTypedData(domain(CHAIN,plan.coordinator),REPORT_TYPES,message);journal.signedReport={schema:'orvia.hybrid-signed-report.v1',operationPlanSha256:plan.operationPlanSha256,chainId:CHAIN,coordinator:plan.coordinator,report:plain(message),digest:reportDigest(CHAIN,plan.coordinator,message),signature};verifySignedReport(context,journal.signedReport);atomicJson(journalFile,journal);}
  const report=verifySignedReport(context,journal.signedReport);state=await readVerifiedState(context,rpc);
  if(state.run.sequence>=report.sequence){const record=context.api.decodeFunctionResult('reportAt',await rpc('eth_call',[{to:plan.coordinator,data:context.api.encodeFunctionData('reportAt',[plan.runId,report.sequence])},'latest']))[0];must(record.attestationDigest===journal.signedReport.digest,'A different report occupies this sequence.');}
  else must(canonical(plain(report))===canonical(plain(reportForState(context,state,report.validUntil))),'Report lineage or deadline changed.');
  if(state.run.sequence>=report.sequence&&!journal.actions.submitReport)throw new SafeError('Exact report was anchored by another relay; no duplicate transaction was sent.');
  progress('submitting_report');await sendAction({plan,approved,context,rpc,wallet,journal,journalFile,name:'submitReport',data:context.api.encodeFunctionData('submitReport',[report,journal.signedReport.signature])});
  state=await readVerifiedState(context,rpc);const final=context.api.decodeFunctionResult('reportAt',await rpc('eth_call',[{to:plan.coordinator,data:context.api.encodeFunctionData('reportAt',[plan.runId,report.sequence])},'latest']))[0];
  must(final.attestationDigest===journal.signedReport.digest&&state.run.status===BigInt(context.assessment.outcome===1?2:3),'Final diagnostic report readback differs.');
  must(connectionActualFee(journal).count===3,'All three transaction receipts are required.');journal.complete=true;atomicJson(journalFile,journal);progress('complete');
  return connectionProgress(plan,'complete',journal,preflight);
}
function options(args){const command=args[0],o={};for(let i=1;i<args.length;i+=2){must(['--plan','--plan-sha','--output','--release-plan','--release-spec','--artifact-spec','--run-id'].includes(args[i])&&args[i+1]&&!o[args[i]],'Expected unique named options.');o[args[i]]=args[i+1];}return{command,o};}
export async function main(args=process.argv.slice(2)){
  const{command,o}=options(args);
  if(command==='prepare'){must(o['--release-plan']&&o['--release-spec']&&o['--artifact-spec']&&o['--run-id']&&o['--output'],'Missing preparation input.');const plan=await prepareConnection({releasePlanFile:o['--release-plan'],releaseSpecFile:o['--release-spec'],artifactSpec:readJson(o['--artifact-spec']),runId:o['--run-id']});fs.writeFileSync(o['--output'],JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({planSha256:plan.planSha256,runId:plan.runId,diagnosticOnly:true,totalTransactions:3}));return;}
  must(['check','connect'].includes(command)&&o['--plan']&&/^[0-9a-f]{64}$/.test(o['--plan-sha']||'')&&o['--output'],'Use check/connect with --plan,--plan-sha,--output.');
  const plan=readJson(o['--plan']),context=verifyConnection(plan,o['--plan-sha']),env=environment(),journalFile=path.join(env.directory,plan.planSha256+'.json');let journal=validateConnectionJournal(journalFile,plan,context),preflight;
  const publish=(stage,extra={})=>atomicJson(o['--output'],connectionProgress(plan,stage,journal,preflight,extra));
  publish('checking');let lock;
  try{
    preflight=await preflightConnection(plan,o['--plan-sha'],env.rpc,journal);publish('ready');
    if(command==='check')return;
    const lockFile=path.join(env.locks,CHAIN+'-'+context.spec.sender.toLowerCase()+'.lock');
    lock=fs.openSync(lockFile,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{
      journal=validateConnectionJournal(journalFile,plan,context);
      preflight=await preflightConnection(plan,o['--plan-sha'],env.rpc,journal);atomicJson(journalFile,journal);publish('ready');
      if(connectionActualFee(journal).count===3){await executeConnection({plan,approved:o['--plan-sha'],context,rpc:env.rpc,wallet:null,journal,journalFile,progressFile:o['--output'],preflight});return;}
      await withHiddenSession(async()=>{let password=await hiddenPrompt('Local encrypted-wallet password (hidden): ');const wallet=await decryptVerified(readPrivateFile(env.file),password,context.spec.sender);password='';await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));verifyConnection(plan,o['--plan-sha']);await readVerifiedState(context,env.rpc);await executeConnection({plan,approved:o['--plan-sha'],context,rpc:env.rpc,wallet,journal,journalFile,progressFile:o['--output'],preflight});});
    }finally{fs.closeSync(lock);lock=undefined;fs.unlinkSync(lockFile);}
  }catch(error){publish('failed',{complete:false,errorCode:'gpu_connection_failed'});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('GPU connection stopped; preserve private connection journal.');process.exitCode=2;});
