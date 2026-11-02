import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract, id, toBeHex, ZeroHash } from 'ethers';
import { artifacts, environment, deploy, transact } from './helpers.mjs';

test('incremental stream authenticates17 real pages beyond65536 words with constant lookup and bounded crossing reads',async t=>{
  const env=await environment();t.after(()=>env.transport.disconnect());
  const catalog=await deploy('PartitionedInputCatalog',env.owner,[await env.owner.getAddress()]);
  const stream=id('real65541-word-stream'), role=id('ORVIA.TEST.RAW.WORDS'), total=65541;
  const gas=[];
  const capture=(scenario,receipt,extra={})=>gas.push({scenario,localGas:receipt.gasUsed.toString(),...extra});
  await assert.rejects(catalog.connect(env.contributor).beginStream(stream,role,total));
  await assert.rejects(catalog.beginStream(ZeroHash,role,total));
  capture('begin65541-word stream',await transact(catalog.beginStream(stream,role,total)));
  await assert.rejects(catalog.assertStream(stream));await assert.rejects(catalog.readWord(stream,0));
  await assert.rejects(catalog.sealStream(stream));
  const pages=[];
  for(let offset=0;offset<total;offset+=4096){
    const count=Math.min(4096,total-offset), receipt=await transact(catalog.createPage(role,count));
    const event=receipt.logs.map(log=>{try{return catalog.interface.parseLog(log);}catch{return null;}}).find(log=>log?.name==='PageCreated');
    const page=new Contract(event.args.page,artifacts.DataPage.abi,env.owner);pages.push(page);
    await assert.rejects(catalog.appendPage.staticCall(stream,event.args.page));
    for(let j=0;j<count;j+=128){
      const values=Array.from({length:Math.min(128,count-j)},(_,i)=>toBeHex(offset+j+i+1,32));
      const written=await transact(page.append(values,{gasLimit:4_000_000}));
      if(j===0&&(offset===0||offset===65536))capture('input page append128-or-finalwords',written,{globalOffset:offset,words:values.length});
    }
    await transact(page.seal(await page.rollingDigest()));
    capture('append sealed page descriptor',await transact(catalog.appendPage(stream,event.args.page)),{pageIndex:offset/4096});
  }
  assert.equal(pages.length,17);
  assert.deepEqual([...(await catalog.streamInfo(stream)).slice(1,5)],[65541n,65541n,17n,false]);
  await assert.rejects(catalog.readWord(stream,0));
  capture('seal17-page stream descriptor',await transact(catalog.sealStream(stream)));
  const info=await catalog.assertStream(stream);assert.equal(info.wordCount,65541n);assert.notEqual(info.commitment,ZeroHash);
  for(const index of [0,4095,4096,65535,65536,65540])assert.equal(await catalog.readWord(stream,index),toBeHex(index+1,32));
  assert.deepEqual([...await catalog.readWords(stream,4093,9)],Array.from({length:9},(_,i)=>toBeHex(4094+i,32)));
  assert.deepEqual([...await catalog.readWords(stream,65533,8)],Array.from({length:8},(_,i)=>toBeHex(65534+i,32)));
  const firstRead=await catalog.readWord.estimateGas(stream,0), lastRead=await catalog.readWord.estimateGas(stream,65540);
  capture('constantlookup firstpage read',{gasUsed:firstRead});capture('constantlookup seventeenthpage read',{gasUsed:lastRead});
  assert.ok(lastRead<firstRead+5000n,'lookup must not scan16 earlierpage descriptors');
  await assert.rejects(catalog.readWord(stream,65541));await assert.rejects(catalog.readWords(stream,65540,2));
  await assert.rejects(catalog.readWords(stream,0,129));await assert.rejects(catalog.sealStream.staticCall(stream));
  await assert.rejects(catalog.appendPage.staticCall(stream,await pages[0].getAddress()));
  const second=id('reuse-should-fail');await transact(catalog.beginStream(second,role,4096));
  await assert.rejects(catalog.appendPage.staticCall(second,await pages[0].getAddress()));
  const foreign=await deploy('DataPage',env.owner,[await env.owner.getAddress(),role,4096]);
  await assert.rejects(catalog.appendPage.staticCall(second,await foreign.getAddress()));
  const empty=id('empty-torsion-stream');await transact(catalog.beginStream(empty,role,0));
  await transact(catalog.sealStream(empty));assert.equal((await catalog.assertStream(empty)).wordCount,0n);
  assert.deepEqual([...await catalog.readWords(empty,0,0)],[]);await assert.rejects(catalog.readWord(empty,0));
  await env.provider.send('evm_setAccountCode',[await pages[16].getAddress(),'0x00']);
  await assert.rejects(catalog.readWord(stream,65536));
  fs.writeFileSync('reports/partitioned_input_gas.json',JSON.stringify({schemaVersion:1,chainId:31337,
    scope:'Real65541-word17-page synthetic input stream, not prepared molecular model or target-chain throughput.',gas},null,2)+'\n');
});
