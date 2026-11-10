# Private Project Notes

An external plugin for the **prototype djgilcrease/t3code plugin-host fork**. This is independent work, with no upstream approval implied. It implements the private project scratchpad requested in [Ideas #9353](https://github.com/pingdotgg/t3code/discussions/9353), extended to multiple text, checklist and image notes.

## Install

Requires the prototype host with `portable-collections` and `thread-portability` capabilities. The tested integrated host is [`a3e3291a18864ca85347fffa2373f04160f91f75`](https://github.com/djgilcrease/t3code/commit/a3e3291a18864ca85347fffa2373f04160f91f75) on `t3/create-plugin-system`. Upstream T3 Code does not include these prototype APIs.

Paste `https://github.com/digitalxero/t3-project-notes` into Settings → Plugins. The tagged repository contains a self-contained `dist/plugin.mjs`; no package installation or build runs on the user's environment.

Open **Notes** in the thread information panel to search all project notes, create a note, or select one to edit. Changes save explicitly. Checklist lines use `- [ ] text` and `- [x] text`, with Toggle and move controls. Image notes support PNG, JPEG, GIF and WebP files up to 64 KiB, with a caption. Notes are private: no agent tools, provider hooks or automatic prompt injection.

## Storage and external editors

Project settings has a notes directory field. The default is exactly `~/.t3/notes/<local_project_id>` on the environment that owns that project. Selecting a new absolute directory copies current notes, imports notes there, and retains the old directory. Keep backups before manually consolidating directories.

Each note version is an ordinary Markdown file with a small `t3-note` frontmatter record. Images are local `assets/` files. Keep the metadata intact when editing in Obsidian. Renames preserve identity; removing a Markdown file records a tombstone. Markdown files without metadata import as text notes. Open or Refresh the panel to import filesystem changes; there is no background filesystem watcher. External edits or deletions made while T3 is stopped are reconciled when it restarts. `.t3-notes/` holds revision inventory and deletion records, not a database of note bodies; preserve that directory when moving or backing up notes.

## Cross-machine sync

Every participating environment persists files. There are no memory-only replicas. Its local project settings selects a custom directory, or its own `~/.t3/notes/<local_project_id>` default.

Project identity is explicit: copy the source's **Shared identity** into an empty destination project's notes settings. The target must have exactly one project configured with that identity. Raw project IDs and repository names never merge projects automatically. Use **Sync notes…** in thread information and choose a connected environment running this plugin. The open client carries bounded authenticated commands between the two environments, so no public endpoint or localhost assumption is required. A completed sync exchanges revisions both ways, including images and tombstones. Concurrent changes remain visible as separate Conflict versions. Delete unwanted versions explicitly.

Sync is user initiated. Offline edits persist locally; reconnect and sync again to reconcile. A closed client or interrupted transfer does not erase either side; retry sync. Incomplete transfer buffers are bounded and expire after five minutes. This is not a continuous cloud synchronization service.

Limits: 200 note IDs (including tombstones), 20 concurrent versions per note, 16 KiB note bodies, 64 KiB per image, 32 MiB total project data, two concurrent transfers. Deletion history is intentionally retained to prevent resurrection. Assets are retained after deletion to avoid destructive cleanup. A project reaching the retained-history limit requires archiving its directory and explicitly starting a new identity.

## Development

Node 24.10 or newer; `npm ci`, `npm run verify` (or `task verify`). The SDK snapshot in `vendor/plugin-sdk` comes from the MIT-licensed prototype host and is used to validate portable UI output. The bundle includes Effect under its MIT license; see `licenses/Effect-MIT.txt`. No server internals are imported.

Verification: storage/plugin tests cover persistence, offline filesystem edits/deletion, durable replicas, project isolation, conflict copies, image transfer and bounded two-way sync. The integrated Linux web client was used to create, open and edit a note, and its Markdown was checked on disk. The normal packaged host worker was used to load the self-contained entrypoint, create/read/edit a note and restart without losing it. Desktop shares the web renderer; native Electron and iOS/Android device behavior have not been exercised. Host affected typechecks, React Compiler checks and focused tests passed locally. Full hosted host CI remained queued at verification time; it is not claimed as passing.

Run `node scripts/verify-packaged-host.mjs <host-checkout>` after building that host with `vp run --filter t3 build:bundle`. It uses the packaged CLI's supervised worker and isolated temporary directories. Repository-URL verification is recorded in the GitHub release once complete.
