import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const [hostRoot, entry = path.resolve('dist/plugin.mjs')] = process.argv.slice(2);
if (!hostRoot) throw new Error('Usage: node scripts/verify-packaged-host.mjs <host-root> [plugin-entry]');
const root = await fs.mkdtemp(path.join(os.tmpdir(),'notes-packaged-'));
const directory = path.join(root,'notes'), dataDirectory = path.join(root,'data');
await fs.mkdir(dataDirectory);
await fs.writeFile(path.join(dataDirectory,'projects.json'), JSON.stringify({'fixture-project':{identity:randomUUID(),directory}}));
const manifest = JSON.parse(await fs.readFile(new URL('../t3-plugin.json',import.meta.url),'utf8'));

async function session(run) {
  const child = spawn(process.execPath,[path.resolve(hostRoot,'apps/server/dist/bin.mjs'),'__plugin-worker'], {stdio:['ignore','pipe','pipe','ipc']});
  const exited = once(child,'exit');
  let next = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdout.resume();
  child.on('message',raw=>{
    const message = typeof raw==='string'?JSON.parse(raw):raw;
    if(message.kind==='host-call') {
      let payload,ok=true;
      if(message.method==='environment-id') payload='packaged-environment';
      else if(message.method==='thread-describe') payload={environmentId:'packaged-environment',environmentLabel:'Packaged fixture',threadId:'fixture-thread',title:'Fixture',projectId:'fixture-project',repository:null,directory:root,branch:null,running:false,subagents:0,archived:false};
      else {ok=false;payload='Unsupported fixture capability';}
      child.send(JSON.stringify({...message,kind:'host-reply',ok,payload}));
    } else if(message.kind==='reply') {
      const request=pending.get(message.id);pending.delete(message.id);
      if(message.ok) request?.resolve(message.payload); else request?.reject(new Error(`Worker rejected request: ${stderr}`));
    }
  });
  child.on('exit',()=>{for(const request of pending.values())request.reject(new Error(`Worker exited: ${stderr}`));pending.clear();});
  const call=(method,payload)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.send(JSON.stringify({kind:'call',id,method,payload,ok:true}));});
  const watchdog = setTimeout(()=>child.kill('SIGTERM'),30000);
  try {
    const loaded=await call('load',{path:path.resolve(entry)});
    assert.equal(loaded.id,manifest.id);assert.equal(loaded.version,manifest.version);
    const contributions=await call('activate',{id:manifest.id,dataDirectory,capabilities:['portable-collections','thread-portability'],httpBasePath:'/api/plugins/project-notes'});
    assert.ok(contributions.commands.every(command=>command.agent===false));
    assert.equal(contributions.mcp,false);assert.equal(contributions.launch,false);
    await run(call);
    await call('shutdown',{});
  } finally {
    clearTimeout(watchdog);
    if(child.connected)child.disconnect();
    await exited;
  }
}
try {
  await session(async call=>{
    const created=await call('command',{id:'create',input:{threadId:'fixture-thread',kind:'text',title:'Packaged private note'}});
    assert.equal(created.tone,'success');
    const view=await call('view',{id:'notes',context:{threadId:'fixture-thread'}});
    assert.equal(view.blocks.find(block=>block.kind==='collection').items[0].label,'Packaged private note');
  });
  await session(async call=>{
    const view=await call('view',{id:'notes',context:{threadId:'fixture-thread'}});
    const item=view.blocks.find(block=>block.kind==='collection').items[0];
    assert.equal(item.label,'Packaged private note');
    const selected=await call('view',{id:'notes',context:{threadId:'fixture-thread',...item.input}});
    const edit=selected.blocks.find(block=>block.id==='edit');
    const saved=await call('command',{id:'save',input:{...edit.input,body:'Persisted through packaged loading and worker restart.'}});
    assert.equal(saved.tone,'success');
  });
  const files=(await fs.readdir(directory)).filter(file=>file.endsWith('.md'));
  assert.equal(files.length,1);
  assert.match(await fs.readFile(path.join(directory,files[0]),'utf8'),/Persisted through packaged loading/);
  console.log(JSON.stringify({packagedLoading:true,workerRestart:true,markdownPersistence:true,agentAccess:false,version:manifest.version,entry:path.resolve(entry)}));
} finally {await fs.rm(root,{recursive:true,force:true});}
