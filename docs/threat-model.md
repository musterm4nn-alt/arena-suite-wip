# Threat Model

## Trust planes (from architecture diagram)

- **UNTRUSTED REMOTE:** Arena WebContents A/B, workers / SW / OOPIF — CDP events / typed isolated-world observations → Electron Main
- **TRUSTED BROWSER CONTROL:** Electron Main (SessionManager, CaptureSupervisor, DownloadManager, Permission/Nav, Key unwrap broker) → typed MessagePort / local IPC
- **PRIVILEGED ARCHIVE SERVICE (utilityProcess):** SQLCipher single writer, observation journal, normalizer, protocol catalog, sync scheduler, artifact sealing, export/deletion/backup, deterministic analysis, MCP service registry → Unix domain socket 0600 → stdio MCP bridge → LLM client

## Key rules

- Arena renderers: sandbox:true, contextIsolation:true, nodeIntegration:false, no application preload API, no filesystem, no DB, no key access, no MCP access. Only injected code is read-only isolated-world witness installed by CDP; removing it degrades only UI corroboration, not network capture.
- Diagnostics GUI: local app origin, strict CSP, narrow context bridge. GUI and MCP call same typed service registry so semantics cannot drift.
- Archive service is sole DB writer. Main may briefly unwrap archive key through Keychain-backed broker at unlock time, transfers it to archive service, then drops its copy. Transient exposure is part of threat model; no key written to ordinary app files.
- Remote content is data, never authority — archived prompts, responses, tool traces, filenames, DOM text and diagnostics cannot authorize deletion or privileged actions.

## Account isolation

- One persistent Session per account: cookies, local/session storage, IndexedDB, HTTP cache, CacheStorage and service-worker registrations stay partition-scoped.
- Capture authority stamped by CaptureSupervisor that owns WebContents; page payloads cannot set account_id.
- Session epoch: every successful sign-in starts epoch; sign-out, identity mismatch or credential invalidation ends it.
- Sync: one queue, token bucket, cursor/checkpoint chain and auth state per account.
- Artifacts: initiating session determines artifact account before file linkage.
- Deletion: directive binds canonical account/conversation IDs and scope hash; A directive for A cannot delete B.

## Sanitization

Drop — not merely redact later — Authorization, Cookie, Set-Cookie, passwords, MFA/verification codes, OAuth codes, CSRF/security tokens, copied bearer strings and secret signed-URL parameters. Represent sensitive resource URL as safe reference {host,path,query_key_set,query_hash,expiry_class}.

Authentication and account-mutation payloads are inventory-only unless narrowly reviewed field is essential. Parser failures never trigger raw dumps. Ordinary logs contain structured event codes and safe identifiers only.

## Destructive-action guard

1. MCP cannot mint approval.
2. Trusted GUI or local CLI shows exact canonical scope and creates random, single-use, short-lived directive.
3. Directive stores scope IDs + count + canonical scope hash + creation time + nonce.
4. Deletion tool must supply directive ID and matching arguments; mismatch, expiry or replay returns E_CONFIRM_REQUIRED.
5. Archive-wide deletion requires strongest owner gesture; account-wide and conversation-level remain scope-specific.
6. Deletion first pauses affected capture/sync, writes tombstone/suppression marker, removes normalized rows/FTS/linked evidence/artifacts transactionally where possible, then vacuums/compacts opportunistically.
7. External exports and backups reported as residual copies; app does not promise deletion from files it no longer controls.

## Prompt injection

Malicious archived text requesting destructive actions must fail without separately minted exact-scope directive. Tested via adversarial MCP tests. No generic arbitrary JS, HTTP request, raw SQL or shell execution as MCP tools.
