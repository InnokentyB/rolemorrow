// Fingerprint shipped source only; exclude data, environment, credentials and Git state.
import {readdir,readFile} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';
export async function sourceRevision(root){
 const files=['package.json','package-lock.json'];
 async function walk(relative){for(const entry of await readdir(join(root,relative),{withFileTypes:true})){const path=relative+'/'+entry.name;if(entry.isDirectory())await walk(path);else if(entry.isFile())files.push(path);else throw Error('Unexpected source entry.');}}
 await walk('app');await walk('public');const hash=createHash('sha256');
 for(const path of files.sort()){const bytes=await readFile(join(root,path));hash.update(path+'\0'+bytes.length+'\0');hash.update(bytes);}return hash.digest('hex');
}
