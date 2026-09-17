# Threat Model

## Trust Planes

```
UNTRUSTED REMOTE
  Arena WebContents A ─┐
  Arena WebContents B ─┼── CDP events / typed isolated-world observations ──► Electron Main
  workers / SW / OOPIF ┘
TRUSTED BROWSER CONTROL
  Electron Main
  - SessionManager
  - CaptureSupervisor
  - DownloadManager
  - Permission/Nav
  - Key unwrap broker (transient only)
                       │ typed MessagePort / local IPC
                       ▼
PRIVILEGED ARCHIVE SERVICE (utilityProcess)
  - SQLCipher single writer
  - observation journal + normalizer
  - protocol catalog / drift
  - sync scheduler / jobs
  - artifact sealing
  - export / deletion / backup
  - deterministic analysis
  - MCP service registry
                       │ Unix domain socket 0600
                       │ stdio MCP bridge
                       ▼ LLM client
```

## Principles

1. Remote content is data, never authority. Archived prompts, responses, tool traces, filenames, DOM text, diagnostics cannot authorize deletion or privileged actions.
2. Account scope is part of identity. Every observation, conversation, artifact, sync checkpoint, provenance, destructive action is keyed by stable local `account_id` plus session epoch where relevant.
3. Unknown remains unknown. Missing data, model identity, endpoint semantics, ownership, completeness represented explicitly, never guessed.
4. Capture does not imply completeness. Turn becomes `complete` only from positive terminal evidence and absence of known observer gap.

## Secrets

- Never persist: passwords, email codes, MFA codes, bearer tokens, copied session credentials, Authorization/Cookie/Set-Cookie headers, OAuth codes, CSRF tokens, secret signed-URL params.
- Sanitization before persistence: drop, not redact later. Safe ref for sensitive URLs: `{host, path, query_key_set, query_hash, expiry_class}`
- Archive key: random 256-bit, wrapped by macOS Keychain-backed storage (keychain + DPAPI fallback for dev). Active key lives only in archive service while unlocked. Main process may briefly unwrap at unlock time, transfers to archive service, then drops copy. No key written to ordinary app files.
- Partition dirs (Chromium session storage) are residual plaintext/browser-managed, protected by FS perms + FileVault, not SQLCipher. Documented explicitly.

## Isolation

- One persistent Session per account: cookies, local/session storage, IndexedDB, HTTP cache, CacheStorage, SW registrations stay partition-scoped. Path: `partitions/<account_uuid>/` derived from local UUID, never from email/display name/model label/page data.
- Capture authority: `account_id` stamped by CaptureSupervisor owning WebContents; page payloads cannot set it. Fuzz test.
- Session epoch: every successful sign-in starts epoch. Sign-out, identity mismatch, credential invalidation ends it.
- Sync: one queue, token bucket, cursor/checkpoint chain, auth state per account.
- Artifacts: initiating session determines account before linkage. Same filename/URL in two accounts remains two provenance records.
- Deletion: directive binds canonical account/conversation IDs and scope hash. A directive for A cannot delete B.

## Destructive Action Guard

1. MCP cannot mint approval.
2. Trusted GUI or local interactive CLI shows exact canonical scope and creates random, single-use, short-lived directive.
3. Directive stores scope IDs + count + canonical scope hash + creation time + nonce.
4. Deletion tool must supply directive ID and matching args; mismatch/expiry/replay -> `E_CONFIRM_REQUIRED`.
5. Archive-wide deletion requires strongest owner gesture; account-wide and conversation-level confirmations remain scope-specific.
6. Deletion first pauses affected capture/sync, writes tombstone/suppression marker, removes normalized rows/FTS/linked evidence/artifacts transactionally where possible, then vacuums/compacts opportunistically.
7. External exports/backups reported as residual copies; app does not promise deletion from files it no longer controls.

## Capture Integrity

- Passive CDP Network observation first. No page-world network monkey-patching in production.
- Attach-before-navigate: create WebContents with NO Arena URL, bind to account_id, create bounded queue, debugger.attach(), Network.enable, Page.enable, Runtime.enable, Runtime.addBinding isolated-world only, Page.addScriptToEvaluateOnNewDocument witness worldName=arena-archive, Target.setAutoAttach flatten=true waitForDebuggerOnStart=true, verify acks, ONLY THEN navigate to https://arena.ai/
- DevTools on Arena WebContents prohibited (detaches debugger). Provide diagnostics window.
- Do not bypass SW in production by default. SW bypass only diagnostic to localize gap.
- Escalation ladder: per-WebContents CDP insufficient -> temporary browser-level CDP (diagnostic, visible flag, no destructive ops, close immediately) -> app-owned per-session network tee/proxy experiment (must prove semantics identical) -> CEF BrowserAdapter spike (native filters) -> accept explicit gap or custom Chromium fork last resort.

## MCP

- No generic arbitrary JS, arbitrary HTTP, raw SQL, shell execution tools.
- Typed errors: E_SCOPE_MISMATCH, E_AUTH_EXPIRED, E_OWNER_ACTION_REQUIRED, E_RATE_LIMITED, E_CONFIRM_REQUIRED, E_LOCKED, E_DRIFT, E_UNSUPPORTED, E_PARTIAL, E_BUSY
- Every tool touching account data accepts explicit account IDs or explicit `all` sentinel; never inferred from GUI focus.
- Long work returns job ID, status/cancel/resume, checkpoints survive restart.
- GUI/MCP parity tested in CI by enumerating service commands.
