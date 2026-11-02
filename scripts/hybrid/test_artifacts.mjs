// Test-only extraction of repository-owned, hash-pinned evidence archives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

export const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export function archiveFiles(relative,expected) {
  const bytes=fs.readFileSync(path.join(repositoryRoot,relative));
  if(createHash('sha256').update(bytes).digest('hex')!==expected) throw new Error('Frozen test archive hash mismatch');
  const tar=gunzipSync(bytes),files=new Map();
  for(let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);
    if(header.every(x=>x===0)) break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim()||'0',8);
    const type=String.fromCharCode(header[156]);
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length) throw new Error('Invalid tar size');
    const content=tar.subarray(offset+512,offset+512+size);
    if(type==='0'||type==='\0') {
      if(!name||path.isAbsolute(name)||name.split('/').some(x=>x==='..'||x==='')||files.has(name)) throw new Error('Unsafe tar member');
      files.set(name,Buffer.from(content));
    } else if(type==='x') {
      // The pinned H200 archive uses per-file PAX fractional mtimes only.
      // Reject path/size/link overrides rather than applying unaudited metadata.
      let cursor=0;
      while(cursor<content.length) {
        const space=content.indexOf(32,cursor),length=Number(content.subarray(cursor,space).toString());
        if(space<cursor||!Number.isSafeInteger(length)||length<=space-cursor+1||cursor+length>content.length) throw new Error('Invalid PAX metadata');
        const record=content.subarray(space+1,cursor+length).toString();
        if(!/^mtime=-?\d+(?:\.\d+)?\n$/.test(record)) throw new Error('Unsupported PAX metadata');
        cursor+=length;
      }
    } else if(type!=='5') throw new Error('Unsupported tar entry in fixture');
    offset+=512+Math.ceil(size/512)*512;
  }
  return files;
}

export function temporaryFixture(prefix) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  return{directory,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
export function extractFixture(files,directory) {
  for(const[name,bytes]of files) {
    const p=path.join(directory,name);
    fs.mkdirSync(path.dirname(p),{recursive:true});
    fs.writeFileSync(p,bytes);
  }
}
