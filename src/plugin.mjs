import * as Effect from 'effect/Effect';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotesStore, imageAsset, limits } from './store.mjs';

const notice = (text, tone = 'success') => ({ $t3:'notice', text, tone });
const relay = (environmentId, command, input) => ({ $t3:'relay', environmentId, command, input, status:'Synchronizing private project notes…' });
const action = (id,label,command,input) => ({id,label,command,input});
const form = (id,label,command,fields,input) => ({id,kind:'form',label,command,fields,input});
const field = (name,label,kind,value) => ({name,label,kind,value});
const text = (id,text) => ({id,kind:'text',text});
const checkedId = id => { if (typeof id !== 'string' || !id || id.length > 200 || /[\\/]/.test(id) || ['.','..'].includes(id)) throw new Error('Invalid project'); return id; };
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export default {
  apiVersion:1, id:'project-notes', name:'Private Project Notes', version:'1.0.0',
  description:'Private Markdown, checklist and image notes shared across project threads. Never sent to agents.',
  activate: context => Effect.gen(function* () {
    if (!context.capabilities?.includes('portable-collections') || !context.threads) throw new Error('Private notes requires the prototype host with portable-collections and thread-portability');
    const configPath = path.join(context.dataDirectory,'projects.json');
    yield* Effect.promise(() => fs.mkdir(context.dataDirectory,{recursive:true,mode:0o700}));
    const config = yield* Effect.promise(() => fs.readFile(configPath,'utf8').then(JSON.parse, e => { if(e.code==='ENOENT') return {}; throw e; }));
    const stores = new Map(), transfers = new Map();
    const environmentId = yield* context.environmentId;
    const saveConfig = async () => {
      const temp = `${configPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temp,JSON.stringify(config),{mode:0o600,flag:'wx'}); await fs.rename(temp,configPath);
    };
    const storeFor = async projectId => {
      checkedId(projectId);
      if (stores.has(projectId)) return stores.get(projectId);
      if (!config[projectId]) { config[projectId] = { identity:randomUUID(), directory:NotesStore.defaultDirectory(projectId) }; await saveConfig(); }
      const pending = new NotesStore(config[projectId]).open(); stores.set(projectId,pending);
      try { const store = await pending; stores.set(projectId,store); return store; } catch(e) { stores.delete(projectId); throw e; }
    };
    const projectFor = async input => input.threadId ? (await Effect.runPromise(context.threads.describe(String(input.threadId)))).projectId : checkedId(input.projectId);
    const wrapped = task => Effect.promise(task).pipe(Effect.catchDefect(() => Effect.succeed(notice('Notes could not be changed. Check directory permissions, note limits, and reopen stale revisions.','danger'))));
    const command = (id,title,run) => ({id,title,description:title,permission:'settings:write',agent:false,run: input => wrapped(() => run(input))});
    const send = (store, target, reply, projectId) => {
      for (const [id,t] of transfers) if (t.expires < Date.now()) transfers.delete(id);
      if (transfers.size >= 2) throw new Error('Sync busy');
      const payload = JSON.stringify(store.snapshot());
      if (Buffer.byteLength(payload) > limits.total) throw new Error('Sync too large');
      const id = randomUUID();
      transfers.set(id,{payload,expires:Date.now()+300000,projectId});
      return relay(environmentId,'send',{transfer:id,offset:0,target,reply,identity:store.identity});
    };
    const commands = [
      command('configure','Configure private notes directory',async input => {
        const projectId = await projectFor(input), store = await storeFor(projectId);
        const directory = String(input.directory || NotesStore.defaultDirectory(projectId));
        if (input.identity && input.identity !== store.identity) {
          if (!uuid(input.identity) || store.snapshot().notes.length) return notice('Set a shared identity only for an empty project. Export or move existing notes first.','danger');
          store.identity = input.identity;
        }
        await store.relocate(directory);
        config[projectId] = {identity:store.identity,directory:store.directory}; await saveConfig();
        return notice('Directory updated. The previous directory and its assets were preserved.');
      }),
      command('create','Create private project note',async input => {
        const store = await storeFor(await projectFor(input));
        await store.save({kind:String(input.kind ?? 'text'),title:String(input.title ?? 'Untitled'),body:String(input.body ?? '')});
        return notice('Note created. Select it in the list to edit.');
      }),
      command('save','Save private project note',async input => {
        const store = await storeFor(await projectFor(input));
        const note = store.list().find(n=>n.id===input.id && n.revision===input.revision);
        if (!note) return notice('This note changed. Reopen it before editing.','warning');
        let asset = note.asset;
        if (input.image) {
          const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(input.image));
          if (!match) throw new Error('Invalid image');
          const data = Buffer.from(match[2],'base64'); if (data.length > 64*1024) return notice('Choose an image of at most 64 KiB.','warning');
          asset = imageAsset(data,match[1]==='jpeg'?'jpg':match[1]);
        }
        await store.save({...note,title:String(input.title ?? note.title),body:String(input.body ?? note.body),...(asset?{asset}:{})});
        return notice('Saved.');
      }),
      command('delete','Delete private project note',async input => {
        const store = await storeFor(await projectFor(input)), note = store.list().find(n=>n.id===input.id && n.revision===input.revision);
        if (note) await store.save({...note,body:'',asset:undefined,deleted:true});
        return notice('Note deleted. Other concurrent versions are kept.');
      }),
      command('checklist','Update private checklist',async input => {
        const store = await storeFor(await projectFor(input)), note = store.list().find(n=>n.id===input.id && n.revision===input.revision);
        if (!note || note.kind !== 'checklist') return notice('Reopen this checklist.','warning');
        const lines = note.body.split('\n'), index = Number(input.index);
        if (!Number.isInteger(index) || index < 0 || index >= lines.length) throw new Error('Invalid item');
        if(input.operation==='toggle') lines[index] = lines[index].replace(/^- \[([ xX])\]/,(_,c)=>`- [${c===' '?'x':' '}]`);
        else { const other = index + (input.operation==='up'?-1:1); if(other>=0 && other<lines.length) [lines[index],lines[other]]=[lines[other],lines[index]]; }
        await store.save({...note,body:lines.join('\n')}); return notice('Checklist updated.');
      }),
      command('sync','Sync private project notes',async input => {
        const projectId = await projectFor(input), store = await storeFor(projectId); await store.refresh();
        if(typeof input.destination!=='string' || input.destination===environmentId) throw new Error('Choose another environment');
        return send(store,input.destination,true,projectId);
      }),
      command('send','Send a bounded private sync chunk',async input => {
        const transfer = transfers.get(input.transfer), offset = Number(input.offset);
        if (!transfer || transfer.expires < Date.now() || !Number.isInteger(offset) || offset<0 || offset>transfer.payload.length) throw new Error('Sync expired');
        const chunk = transfer.payload.slice(offset,offset+24000), end = offset+chunk.length;
        if(end === transfer.payload.length) transfers.delete(input.transfer);
        return relay(String(input.target),'receive',{transfer:input.transfer,identity:input.identity,source:environmentId,chunk,offset,total:transfer.payload.length,reply:input.reply,end,sourceProject:transfer.projectId});
      }),
      command('receive','Receive a bounded private sync chunk',async input => {
        for (const [id,t] of transfers) if(t.expires<Date.now()) transfers.delete(id);
        const matches = Object.entries(config).filter(([,c])=>c.identity===input.identity);
        if(matches.length!==1) return notice('Configure exactly one empty project on this machine with the source project’s shared identity before syncing.','warning');
        const [projectId] = matches[0], total = Number(input.total), offset = Number(input.offset), chunk = String(input.chunk);
        if(!uuid(input.transfer) || !Number.isInteger(total) || total<0 || total>limits.total || chunk.length>24000 || !Number.isInteger(offset)) throw new Error('Invalid sync chunk');
        let transfer = transfers.get(input.transfer);
        if (!transfer) { if(offset!==0 || transfers.size>=2) throw new Error('Sync busy'); transfer={payload:'',expires:Date.now()+300000,identity:input.identity,source:input.source,total}; transfers.set(input.transfer,transfer); }
        if(transfer.identity!==input.identity || transfer.source!==input.source || transfer.total!==total || transfer.payload.length!==offset || offset+chunk.length>total) throw new Error('Invalid sync sequence');
        transfer.payload+=chunk;
        if(transfer.payload.length<total) return relay(String(input.source),'send',{transfer:input.transfer,identity:input.identity,offset:transfer.payload.length,target:environmentId,reply:input.reply});
        const store = await storeFor(projectId); await store.merge(JSON.parse(transfer.payload)); transfers.delete(input.transfer);
        if(input.reply) return send(store,String(input.source),false,projectId);
        return notice('Private notes synchronized in both directions. Files and images persist on each participating environment.');
      }),
    ];
    const read = async (input = {}) => {
      const projectId = await projectFor(input), store = await storeFor(projectId); await store.refresh();
      const notes = store.list(), selected = notes.find(n=>`${n.id}:${n.revision}`===input.selected) ?? notes.find(n=>n.id===input.selectedId);
      const base = {projectId};
      const blocks = [text('privacy','Private to you. Never included in prompts or exposed as agent tools.'),
        {id:'notes',kind:'collection',queryField:'query',label:'Project notes',items:notes.filter(n=>`${n.title} ${n.body}`.toLocaleLowerCase().includes(String(input.query ?? '').toLocaleLowerCase())).map(n=>({id:`${n.id}:${n.revision}`,label:`${n.conflict?'Conflict: ':''}${n.title || 'Untitled'}`.slice(0,200),search:n.body.slice(0,100),input:{selected:`${n.id}:${n.revision}`,selectedId:n.id}}))},
        form('create','Create note','create',[field('title','Title','text',''),{...field('kind','Type','select','text'),options:[{label:'Text',value:'text'},{label:'Checklist',value:'checklist'},{label:'Image',value:'image'}]}],base)];
      if (selected) {
        const ref = {...base,id:selected.id,revision:selected.revision};
        if (selected.asset) blocks.push({id:'image',kind:'image',label:selected.title,source:`data:image/${selected.asset.name.endsWith('.jpg')?'jpeg':selected.asset.name.split('.')[1]};base64,${selected.asset.data}`});
        blocks.push(form('edit','Save note','save',[field('title','Title','text',selected.title),field('body',selected.kind==='checklist'?'Checklist (one “- [ ] item” per line)':'Note','multiline',selected.body),...(selected.kind==='image'?[field('image','Image (PNG/JPEG/GIF/WebP, at most 64 KiB)','image','')]:[])],ref));
        if(selected.kind==='checklist') blocks.push({id:'items',kind:'table',columns:['Checklist'],rows:selected.body.split('\n').slice(0,80).map((line,index)=>({id:String(index),cells:[line],actions:[action(`toggle-${index}`,'Toggle','checklist',{...ref,index,operation:'toggle'}),action(`up-${index}`,'↑','checklist',{...ref,index,operation:'up'}),action(`down-${index}`,'↓','checklist',{...ref,index,operation:'down'})]}))});
        blocks.push({id:'delete',kind:'actions',actions:[action('delete','Delete this version','delete',ref)]});
      }
      blocks.push(text('directory',`Notes directory: ${store.directory}\nShared identity: ${store.identity}\nTo sync: set this identity on an empty destination project, then use “Sync notes…” in thread info. Changes made offline are merged on the next explicit sync.`));
      return {title:'Private Project Notes',blocks};
    };
    return {commands,views:[
      {id:'notes',title:'Notes',location:'thread-panel',permission:'orchestration:read',read:input=>Effect.promise(()=>read(input))},
      {id:'directory',title:'Private Project Notes',location:'project-settings',permission:'orchestration:read',read:input=>Effect.promise(async()=>{
        const projectId=await projectFor(input),store=await storeFor(projectId);
        return {title:'Private Project Notes',blocks:[text('privacy','Private user notes. Use the Notes dropdown in thread info.'),form('directory','Save notes settings','configure',[field('directory','Notes directory (absolute path on this machine)','text',store.directory),field('identity','Shared project identity (change only while empty)','text',store.identity)],{projectId})]};
      })},
      {id:'sync',title:'Notes sync',location:'thread-details',permission:'orchestration:read',read:()=>Effect.succeed({title:'Private notes',blocks:[{id:'sync',kind:'status',actions:[{id:'sync',label:'Sync notes…',command:'sync',input:{},environment:{name:'destination',label:'Sync with environment'}}]}]})},
    ]};
  }),
};
