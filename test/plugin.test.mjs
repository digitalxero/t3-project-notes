import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Effect from 'effect/Effect';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import plugin from '../src/plugin.mjs';
import { PluginView } from '../vendor/plugin-sdk/index.ts';
import * as Schema from 'effect/Schema';

async function fixture(t,identity=randomUUID()) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notes-plugin-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const actors={};
  for(const env of ['left','right']) {
    const dataDirectory=path.join(root,env,'data'),directory=path.join(root,env,'notes'),projectId=`${env}-project`;
    await fs.mkdir(dataDirectory,{recursive:true});await fs.writeFile(path.join(dataDirectory,'projects.json'),JSON.stringify({[projectId]:{identity,directory}}));
    actors[env]=await Effect.runPromise(plugin.activate({dataDirectory,capabilities:['portable-collections'],environmentId:Effect.succeed(env),threads:{describe:()=>Effect.succeed({projectId})}}));
  }
  const run=(env,id,input)=>Effect.runPromise(actors[env].commands.find(c=>c.id===id).run(input));
  return {actors,run,root};
}
test('all commands stay private; project dropdown sees all threads; text checklist image lifecycle and two-way bounded sync persist after restart',async t=>{
  const {actors,run,root}=await fixture(t);
  assert.ok(Object.values(actors).every(a=>a.commands.every(c=>c.agent===false)));
  await run('left','create',{threadId:'thread-a',kind:'text',title:'Keep me'});
  await run('left','create',{threadId:'thread-b',kind:'checklist',title:'Tasks',body:'- [ ] first\n- [x] second'});
  const read=()=>Effect.runPromise(actors.left.views.find(v=>v.id==='notes').read({threadId:'thread-c'}));
  let view=await read();assert.equal(view.blocks.find(b=>b.kind==='collection').items.length,2);
  Schema.decodeUnknownSync(PluginView)(view);
  const checklist=(await fs.readdir(path.join(root,'left','notes'))).find(n=>n.endsWith('.md'));
  assert.ok(checklist);
  const item=view.blocks.find(b=>b.kind==='collection').items.find(n=>n.label==='Tasks');
  view=await Effect.runPromise(actors.left.views.find(v=>v.id==='notes').read({threadId:'thread-c',...item.input}));
  const toggle=view.blocks.find(b=>b.kind==='table').rows[0].actions[0];await run('left',toggle.command,toggle.input);
  await run('left','create',{threadId:'x',kind:'image',title:'Picture'});
  view=await read();const imageItem=view.blocks.find(b=>b.kind==='collection').items.find(n=>n.label==='Picture');
  view=await Effect.runPromise(actors.left.views.find(v=>v.id==='notes').read({threadId:'x',...imageItem.input}));
  const edit=view.blocks.find(b=>b.kind==='form' && b.id==='edit');
  assert.equal((await run('left','save',{...edit.input,image:'data:image/png;base64,iVBORw0KGgoAAAAA'})).tone,'success');
  await run('right','create',{threadId:'remote',title:'Remote offline edit'});
  let reply=await run('left','sync',{threadId:'x',destination:'right'}),steps=0;
  while(reply?.$t3==='relay') {assert.ok(++steps<5000);assert.ok(Buffer.byteLength(JSON.stringify(reply.input))<256*1024);reply=await run(reply.environmentId,reply.command,reply.input);}
  assert.equal(reply.tone,'success');
  for(const env of ['left','right']) {
    const directory=path.join(root,env,'notes');assert.equal((await fs.readdir(directory)).filter(n=>n.endsWith('.md')).length,4);
    assert.equal((await fs.readdir(path.join(directory,'assets'))).length,1);
  }
});
