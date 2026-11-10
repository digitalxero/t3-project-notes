import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const limits = { notes: 200, text: 16384, image: 64 * 1024, total: 32 * 1024 * 1024 };
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const bytes = value => Buffer.byteLength(value);
const checked = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dominates = (a, b) => Object.entries(b).every(([k, v]) => (a[k] ?? 0) >= v);
const clockJoin = clocks => Object.fromEntries([...new Set(clocks.flatMap(c => Object.keys(c)))].map(k => [k, Math.max(...clocks.map(c => c[k] ?? 0))]));
const fileExists = async p => fs.stat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}
function validate(note) {
  checked(note && uuid(note.id) && uuid(note.revision), 'Invalid note identity');
  checked(['text', 'checklist', 'image'].includes(note.kind), 'Invalid note kind');
  checked(typeof note.title === 'string' && bytes(note.title) <= 512, 'Title too long');
  checked(typeof note.body === 'string' && bytes(note.body) <= limits.text, 'Note too large');
  checked(typeof note.deleted === 'boolean', 'Invalid deletion');
  checked(note.clock && Object.keys(note.clock).length <= 100 && Object.entries(note.clock).every(([k,v]) => uuid(k) && Number.isSafeInteger(v) && v > 0), 'Invalid revision clock');
  if (note.asset) {
    checked(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(note.asset.name), 'Invalid image asset');
    const data = Buffer.from(note.asset.data, 'base64');
    checked(data.length <= limits.image && hash(data) === note.asset.name.split('.')[0], 'Invalid image bytes');
    const signatures = { png: '89504e470d0a1a0a', jpg: 'ffd8ff', gif: '47494638', webp: '52494646' };
    checked(data.subarray(0, signatures[note.asset.name.split('.')[1]].length / 2).toString('hex') === signatures[note.asset.name.split('.')[1]], 'Unsupported image');
  }
  return note;
}
export class NotesStore {
  #tail = Promise.resolve();
  constructor({ actor = randomUUID(), directory = null, identity = randomUUID() } = {}) {
    checked(uuid(actor) && uuid(identity), 'Invalid store identity');
    this.actor = actor; this.identity = identity; this.directory = directory; this.versions = new Map(); this.files = new Map();
  }
  serial(task) { const next = this.#tail.then(task); this.#tail = next.catch(() => {}); return next; }
  static defaultDirectory(projectId, home = os.homedir()) {
    checked(typeof projectId === 'string' && projectId.length > 0 && !/[\\/]/.test(projectId) && !['.', '..'].includes(projectId), 'Invalid project id');
    return path.join(home, '.t3', 'notes', projectId);
  }
  list() { return [...this.versions.values()].flat().filter(n => !n.deleted).map(n => ({ ...n, conflict: this.versions.get(n.id).length > 1 })); }
  #merge(note) {
    validate(note);
    const old = this.versions.get(note.id) ?? [];
    const duplicate = old.find(n => n.revision === note.revision);
    if (duplicate) { checked(same(duplicate, note), 'Revision reused with different contents'); return; }
    if (old.some(n => dominates(n.clock, note.clock))) return;
    this.versions.set(note.id, [...old.filter(n => !dominates(note.clock, n.clock)), structuredClone(note)].sort((a,b) => a.revision.localeCompare(b.revision)));
  }
  #bound() {
    checked(this.versions.size <= limits.notes, 'Project note limit reached');
    checked(bytes(JSON.stringify([...this.versions])) <= limits.total, 'Project storage limit reached');
    checked([...this.versions.values()].every(v => v.length <= 20), 'Too many concurrent revisions');
  }
  async open() { return this.serial(async () => { await this.#scan(); return this; }); }
  async #scan() {
    if (!this.directory) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.files.size === 0) {
      const inventory = path.join(this.directory, '.t3-notes', 'inventory.json');
      if (await fileExists(inventory)) {
        checked((await fs.stat(inventory)).size <= limits.total, 'Inventory too large');
        this.files = new Map(JSON.parse(await fs.readFile(inventory, 'utf8')));
        checked([...this.files.keys()].every(n => typeof n === 'string' && path.basename(n) === n && n.endsWith('.md')), 'Invalid inventory');
      }
    }
    const present = new Map();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(this.directory, entry.name);
      checked((await fs.stat(file)).size <= limits.text + 16384, 'External Markdown exceeds size limit');
      const text = await fs.readFile(file, 'utf8');
      const match = /^---\nt3-note: (.+)\n---\n(?:!\[.*?\]\(assets\/[^)]+\)\n)?([\s\S]*)$/.exec(text);
      let note;
      if (match) {
        note = JSON.parse(match[1]); note.body = match[2];
        if (note.asset) {
          checked(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(note.asset.name), 'Unsafe external image path');
          const assetPath = path.join(this.directory, 'assets', note.asset.name);
          const stat = await fs.lstat(assetPath);
          checked(stat.isFile() && stat.size <= limits.image, 'Unsafe image asset');
          note.asset.data = (await fs.readFile(assetPath)).toString('base64');
        }
        validate(note);
        const known = (this.versions.get(note.id) ?? []).find(n => n.revision === note.revision);
        const externallyChanged = note.contentHash && note.contentHash !== hash(note.body);
        delete note.contentHash;
        if (externallyChanged || (known && !same(known, note))) note = { ...note, clock: clockJoin([known?.clock ?? {}, note.clock]), revision: randomUUID() }, note.clock[this.actor] = (note.clock[this.actor] ?? 0) + 1;
      } else {
        const knownFile = this.files.get(entry.name);
        const previous = knownFile && this.versions.get(knownFile.id)?.find(n => n.revision === knownFile.revision);
        note = { id: previous?.id ?? randomUUID(), revision: randomUUID(), clock: { ...(previous?.clock ?? {}), [this.actor]: (previous?.clock[this.actor] ?? 0) + 1 }, kind: 'text', title: entry.name.slice(0,-3), body: text, deleted: false };
      }
      this.#merge(note); present.set(entry.name, { id: note.id, revision: note.revision });
    }
    const tombstonePath = path.join(this.directory, '.t3-notes', 'tombstones.json');
    if (await fileExists(tombstonePath)) {
      checked((await fs.stat(tombstonePath)).size <= limits.total, 'Tombstone limit reached');
      for (const note of JSON.parse(await fs.readFile(tombstonePath, 'utf8'))) this.#merge(note);
    }
    for (const [filename, old] of this.files) {
      if (present.has(filename) || [...present.values()].some(n => n.id === old.id && n.revision === old.revision)) continue;
      const previous = this.versions.get(old.id)?.find(n => n.revision === old.revision) ?? old.note;
      if (previous) this.#merge({ ...previous, asset: undefined, body: '', deleted: true, revision: randomUUID(), clock: { ...previous.clock, [this.actor]: (previous.clock[this.actor] ?? 0) + 1 } });
    }
    this.files = present; this.#bound();
  }
  async refresh() { return this.serial(async () => { await this.#scan(); await this.#persist(); return this.list(); }); }
  async save({ id = randomUUID(), revision = null, kind = 'text', title = '', body = '', asset, deleted = false }) {
    return this.serial(async () => {
      await this.#scan();
      const old = this.versions.get(id) ?? [];
      const base = revision ? old.find(n => n.revision === revision) : undefined;
      checked(!revision || base, 'This revision changed; reopen the note before saving');
      const clock = { ...(base?.clock ?? {}), [this.actor]: (base?.clock[this.actor] ?? 0) + 1 };
      const note = { id, revision: randomUUID(), clock, kind, title, body, deleted, ...(asset ? { asset } : {}) };
      const before = structuredClone(this.versions);
      try { this.#merge(note); this.#bound(); await this.#persist(); } catch (e) { this.versions = before; throw e; }
      return note;
    });
  }
  async merge(snapshot) {
    return this.serial(async () => {
      checked(snapshot.identity === this.identity && snapshot.version === 1 && Array.isArray(snapshot.notes) && snapshot.notes.length <= limits.notes * 20, 'Project identity or protocol mismatch');
      checked(bytes(JSON.stringify(snapshot)) <= limits.total, 'Sync too large');
      await this.#scan();
      const before = structuredClone(this.versions);
      try { for (const note of snapshot.notes) this.#merge(note); this.#bound(); await this.#persist(); } catch (e) { this.versions = before; throw e; }
      return this.list();
    });
  }
  snapshot() { return { version: 1, identity: this.identity, notes: structuredClone([...this.versions.values()].flat()) }; }
  async #persist() {
    if (!this.directory) return;
    const wanted = new Map();
    for (const note of this.list()) {
      const existing = [...this.files].find(([,n]) => n.id === note.id && n.revision === note.revision)?.[0];
      const filename = existing ?? `${note.id}-${note.revision}.md`;
      const { body, conflict, ...metadata } = note;
      metadata.contentHash = hash(body);
      if (metadata.asset) {
        const { data, name } = metadata.asset;
        await atomic(path.join(this.directory, 'assets', name), Buffer.from(data,'base64'));
        metadata.asset = { name };
      }
      await atomic(path.join(this.directory, filename), `---\nt3-note: ${JSON.stringify(metadata)}\n---\n${metadata.asset ? `![${note.title.replace(/[\]\r\n]/g,'') }](assets/${metadata.asset.name})\n` : ''}${body}`);
      wanted.set(filename, { id: note.id, revision: note.revision, note: { ...note, body: "", asset: undefined, conflict: undefined } });
    }
    await atomic(path.join(this.directory, '.t3-notes', 'tombstones.json'), JSON.stringify([...this.versions.values()].flat().filter(n => n.deleted)));
    for (const [file] of this.files) if (!wanted.has(file)) await fs.unlink(path.join(this.directory, file)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await atomic(path.join(this.directory, ".t3-notes", "inventory.json"), JSON.stringify([...wanted]));
    this.files = wanted;
  }
  async relocate(directory) {
    return this.serial(async () => {
      checked(path.isAbsolute(directory), 'Choose an absolute directory');
      await this.#scan();
      const old = this.directory, oldFiles = this.files;
      this.directory = directory; this.files = new Map();
      try { await this.#scan(); await this.#persist(); } catch (e) { this.directory = old; this.files = oldFiles; throw e; }
      return directory;
    });
  }
}
export function imageAsset(data, extension) { return { name: `${hash(data)}.${extension}`, data: Buffer.from(data).toString('base64') }; }
