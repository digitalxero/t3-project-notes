import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotesStore, imageAsset } from '../src/store.mjs';
const temp = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'private-notes-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

test('owning environment defaults to exact home directory; unsafe project IDs fail', () => {
  assert.equal(NotesStore.defaultDirectory('project', '/home/person'), '/home/person/.t3/notes/project');
  assert.throws(() => NotesStore.defaultDirectory('../oops'));
});
test('Markdown survives restart and external edits, rename and deletion synchronize', async t => {
  const directory = await temp(t), identity = randomUUID();
  const store = await new NotesStore({ directory, identity }).open();
  await store.save({ title: 'Private', body: 'hello' });
  const file = (await fs.readdir(directory)).find(n => n.endsWith('.md'));
  await fs.rename(path.join(directory,file), path.join(directory,'renamed.md'));
  await store.refresh(); assert.equal(store.list().length,1);
  await fs.writeFile(path.join(directory,'renamed.md'), (await fs.readFile(path.join(directory,'renamed.md'),'utf8')).replace('hello','outside'));
  await store.refresh(); assert.equal(store.list()[0].body,'outside');
  const restarted = await new NotesStore({ directory, identity }).open();
  assert.equal(restarted.list()[0].body,'outside');
  await fs.unlink(path.join(directory,'renamed.md')); await store.refresh();
  assert.equal(store.list().length,0);
  await restarted.merge(store.snapshot()); assert.equal(restarted.list().length,0);
});
test('default replica directory persists synced notes through restart and offline editing', async t => {
  const home = await temp(t), identity = randomUUID();
  const owner = new NotesStore({identity}); await owner.save({title:'Synced',body:'offline ready'});
  const directory = NotesStore.defaultDirectory('replica-project',home);
  const replica = await new NotesStore({identity,directory}).open(); await replica.merge(owner.snapshot());
  const restarted = await new NotesStore({identity,directory}).open();
  assert.equal(restarted.list()[0].body,'offline ready');
  await restarted.save({...restarted.list()[0],body:'edited while disconnected'});
  await owner.merge(restarted.snapshot());assert.equal(owner.list()[0].body,'edited while disconnected');
});
test('concurrent edits and edit versus deletion converge without silent data loss', async () => {
  const identity = randomUUID(), left = new NotesStore({ identity }), right = new NotesStore({ identity });
  const original = await left.save({ title:'original', body:'start' });
  await right.merge(left.snapshot());
  await left.save({ ...original, title:'left' }); await right.save({ ...original, title:'right' });
  await left.merge(right.snapshot()); await right.merge(left.snapshot());
  assert.deepEqual(left.snapshot(),right.snapshot()); assert.equal(left.list().length,2); assert.ok(left.list().every(n=>n.conflict));
  const a = left.list()[0]; await left.save({ ...a, deleted:true, body:'' });
  await right.save({ ...right.list()[0], body:'concurrent edit' });
  await left.merge(right.snapshot()); await right.merge(left.snapshot());
  assert.deepEqual(left.snapshot(),right.snapshot()); assert.ok(left.list().some(n=>n.body==='concurrent edit'));
});
test('custom replica persists synced images and changing directory preserves old files', async t => {
  const directory = await temp(t), destination = await temp(t), identity = randomUUID();
  const owner = new NotesStore({ identity });
  const asset = imageAsset(Buffer.from('89504e470d0a1a0a00000000','hex'),'png');
  await owner.save({ kind:'image',title:'drawing',body:'caption',asset });
  const replica = await new NotesStore({ identity, directory }).open();
  await replica.merge(owner.snapshot()); await replica.relocate(destination);
  assert.ok((await fs.readdir(directory)).some(n=>n.endsWith('.md')));
  assert.ok((await fs.readdir(destination)).some(n=>n.endsWith('.md')));
  const restarted = await new NotesStore({ identity,directory:destination }).open();
  assert.equal(restarted.list()[0].asset.data,asset.data);
});
test('identity mismatch and invalid remote data leave prior state intact', async () => {
  const s = new NotesStore(); await s.save({ title:'keep' });
  const before = s.snapshot();
  await assert.rejects(s.merge({ ...before,identity:randomUUID() }));
  await assert.rejects(s.merge({ ...before,notes:[{...before.notes[0],id:'../../unsafe'}] }));
  assert.deepEqual(s.snapshot(),before);
});
test('an external edit made while host is stopped gets a new revision on restart', async t => {
  const directory = await temp(t), identity = randomUUID();
  const owner = await new NotesStore({ directory, identity }).open();
  await owner.save({body:'before'}); const replica = new NotesStore({identity}); await replica.merge(owner.snapshot());
  const file = (await fs.readdir(directory)).find(n=>n.endsWith('.md'));
  await fs.writeFile(path.join(directory,file),(await fs.readFile(path.join(directory,file),'utf8')).replace(/before$/, 'after'));
  const restarted = await new NotesStore({directory,identity}).open();
  await replica.merge(restarted.snapshot()); assert.equal(replica.list()[0].body,'after');
});
test('offline filesystem deletion survives restart as a tombstone',async t=>{
  const directory=await temp(t),identity=randomUUID(); const s=await new NotesStore({directory,identity}).open();
  await s.save({body:'delete offline'});const other=new NotesStore({identity});await other.merge(s.snapshot());
  await fs.unlink(path.join(directory,(await fs.readdir(directory)).find(n=>n.endsWith('.md'))));
  const restarted=await new NotesStore({directory,identity}).open();await other.merge(restarted.snapshot());assert.equal(other.list().length,0);
});
