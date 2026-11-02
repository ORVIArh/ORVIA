// Conditional local gas measurement only. Importing never opens a wallet or network.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Wallet,Interface,AbiCoder,id,toBeHex,toQuantity,keccak256,getAddress} from 'ethers';
import {domain,REPORT_TYPES,normalizeReport,reportDigest} from './attestation.mjs';
import {expectedIdentities} from './report_operator.mjs';
const require=createRequire(import.meta.url),ganache=require('ganache');
const ZERO='0x'+'00'.repeat(32),coder=AbiCoder.defaultAbiCoder();
const sha=x=>createHash('sha256').update(x).digest('hex');
const must=(ok,message)=>{if(!ok)throw Error(message);};

export async function measureConnection(context) {
  const assessment=structuredClone(context.assessment),runId=context.plan.runId;
  must(assessment?.diagnosticOnly===true&&assessment.configuration?.diagnosticOnly===true,
    'Only an explicitly diagnostic assessment may be measured by this fixture.');
  must(typeof runId==='string'&&/^0x[0-9a-f]{64}$/i.test(runId)&&runId!==ZERO,'Nonzero run ID required.');
  const artifacts=context.bundle?.artifacts,c=artifacts?.ORVIAHybridCoordinator,s=artifacts?.ORVIAReportShard;
  must(c?.creation&&s?.creation&&c.storageLayout?.storage,'Complete compiled hybrid artifacts required.');
  const field=c.storageLayout.storage.find(x=>x.label==='shardCount');
  must(field?.type==='t_uint16'&&field.offset===0&&c.storageLayout.storage.filter(x=>x.slot===field.slot).length===1,
    'Unexpected shardCount storage layout.');
  // This publicly derivable test key must never be funded or used on any public chain.
  const key=id('ORVIA conditional local GPU connection gas fixture DO NOT FUND'),operator=new Wallet(key);
  const vm=ganache.provider({logging:{quiet:true},chain:{chainId:4663,hardfork:'shanghai'},
    miner:{blockGasLimit:30000000},wallet:{accounts:[{secretKey:key,balance:toBeHex(1000n*10n**18n)}]}});
  const rpc=(method,params=[])=>vm.request({method,params});
  const api=new Interface(c.abi),price='0x77359400';
  const tx=async(to,data)=>{
    const hash=await rpc('eth_sendTransaction',[{from:operator.address,...(to?{to}:{}),data,value:'0x0',gas:'0x1c9c380',gasPrice:price}]);
    const receipt=await rpc('eth_getTransactionReceipt',[hash]);
    must(receipt&&BigInt(receipt.status)===1n,'Local measurement transaction reverted.');
    return receipt;
  };
  try {
    const deployment=await tx(null,c.creation+api.encodeDeploy([operator.address,operator.address]).slice(2));
    const coordinator=getAddress(deployment.contractAddress);
    const call=async(name,args=[])=>api.decodeFunctionResult(name,await rpc('eth_call',[{to:coordinator,data:api.encodeFunctionData(name,args)},'latest']));
    const lane=Number((await call('laneFor',[runId]))[0]),slot=toBeHex(BigInt(field.slot),32);
    // The measured run uses one genuinely created/authenticated shard. Remaining lanes are omitted.
    await rpc('evm_setAccountStorageAt',[coordinator,slot,toBeHex(lane,32)]);await rpc('evm_mine');
    await tx(coordinator,api.encodeFunctionData('createShards',[1]));
    await rpc('evm_setAccountStorageAt',[coordinator,slot,toBeHex(255,32)]);await rpc('evm_mine');
    must((await call('deploymentReady'))[0]===true&&Number((await call('shardCount'))[0])===255,'Injected local readiness failed.');
    const shard=getAddress((await call('shards',[lane]))[0]);
    const shardCode=await rpc('eth_getCode',[shard,'latest']);must(shardCode!=='0x','Measured run shard is missing.');
    must((await call('shardCodeHash',[lane]))[0]===keccak256(shardCode),'Measured shard code hash mismatch.');
    const local={...context,assessment,plan:{...context.plan,coordinator},spec:{...context.spec,sender:operator.address,owner:operator.address,operator:operator.address},api};
    const receipts=[];
    for(const [name,args]of [['registerExperiment',[assessment.experimentId,assessment.configuration]],['startRun',[assessment.experimentId,runId,assessment.runConfigHash,assessment.checkpointHash]]]) {
      const receipt=await tx(coordinator,api.encodeFunctionData(name,args));receipts.push({name,gasUsed:BigInt(receipt.gasUsed).toString(),transactionHash:receipt.transactionHash,status:1});
    }
    const run=(await call('runInfo',[runId]))[0],identities=expectedIdentities(local);
    must(run.status===1n&&run.configurationHash===identities.runHash&&run.sequence===0n&&run.diagnosticOnly===true,'Local running state differs from exact assessment.');
    const block=await rpc('eth_getBlockByNumber',['latest',false]);
    const message=normalizeReport({runId,configurationHash:run.configurationHash,sequence:1n,
      completedSteps:assessment.completedSteps,previousCheckpointHash:run.latestCheckpointHash,
      checkpointHash:assessment.checkpointHash,resultHash:assessment.resultHash,outcome:assessment.outcome,
      checks:assessment.checks,validUntil:BigInt(block.timestamp)+1800n});
    const signature=await operator.signTypedData(domain(4663,coordinator),REPORT_TYPES,message);
    const digest=reportDigest(4663,coordinator,message);
    must((await call('reportDigest',[message]))[0]===digest,'Synthetic EIP712 digest mismatch.');
    const submitted=await tx(coordinator,api.encodeFunctionData('submitReport',[message,signature]));
    receipts.push({name:'submitReport',gasUsed:BigInt(submitted.gasUsed).toString(),transactionHash:submitted.transactionHash,status:1});
    const record=(await call('reportAt',[runId,1]))[0],after=(await call('runInfo',[runId]))[0];
    must(record.attestationDigest===digest&&after.sequence===1n&&after.completedSteps===BigInt(assessment.completedSteps),
      'Measured report was not retained exactly.');
    const gas=Object.fromEntries(receipts.map(x=>[x.name,x.gasUsed]));
    return {schema:'orvia.gpu-connection.conditional-local-gas.v1',conditionalLocal:true,
      localFixtureReadinessInjected:true,unusedShardsOmitted:254,publicTransactionsSent:0,usedProductionWallet:false,
      gas,totalGas:receipts.reduce((sum,r)=>sum+BigInt(r.gasUsed),0n).toString(),receipts,
      fixture:{chainId:4663,hardfork:'shanghai',actualContracts:2,coordinator,shard,runLane:lane,
        syntheticSigner:operator.address,syntheticSignature:true,shardCountSlot:field.slot,
        storageInjection:'Set shardCount to run lane, genuinely create that one shard, then set readiness count255; other254shards absent.'},
      assessment:{runId,diagnosticOnly:true,completedSteps:String(assessment.completedSteps),checks:assessment.checks,
        outcome:assessment.outcome,counterUnit:assessment.counterUnit},
      sources:{helperSha256:sha(fs.readFileSync(new URL('./connect_gpu_cost.mjs',import.meta.url))),
        coordinatorCreationKeccak256:keccak256(c.creation),shardCreationKeccak256:keccak256(s.creation),
        compilerBinding:context.bundle.binding??null},
      scope:'Three actual local lifecycle receipt gas measurements only, with synthetic identities and readiness-injected partial deployment. Includes local intrinsic calldata/execution gas; excludes target L1 allocation, deployment, GPU work, and future lifecycle calls. Not a target fee quote or full-network rehearsal.'};
  } finally {await vm.disconnect();}
}
