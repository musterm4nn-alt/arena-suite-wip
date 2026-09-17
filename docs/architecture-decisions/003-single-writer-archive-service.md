# ADR 003 — Archive Service as Single Writer, Utility Process

**Status:** Accepted
**Date:** 2026-09-17
**Context:** §4 Process and trust model, §10 Data model, §11 Storage.

**Decision:**
- Archive service runs as Electron utilityProcess (Node, no DOM).
- Sole SQLite writer (SQLCipher-compatible + FTS5).
- Main process may briefly unwrap archive key through Keychain-backed broker at unlock time, transfers to archive service, then drops copy. Transient exposure explicitly part of threat model; no key written to ordinary app files.
- First durable write is append-only observations record in SQLCipher; normalization in same or subsequent bounded transaction. Uses encrypted DB itself as journal, avoids second persistence format.
- WAL encrypted with DB, conservative durability, measure capture latency before tuning.
- Artifact commit protocol: stage -> hash/MIME sniff -> encrypt to temp sealed blob -> fsync -> atomic rename -> DB commit -> remove plaintext staging.

**Rationale:**
- Prevents concurrent writer corruption.
- Isolates key handling to privileged service.
- Provides transactional integrity for observations + normalized core + FTS.

**Consequences:**
- Need MessagePort / typed IPC between main and archive service.
- Need startup integrity checks, orphan staging recovery, blob reconciliation, FTS rebuild.
- Need numbered, transactional, forward-only migrations preceded by verified encrypted backup.

**Security:**
- Sanitization before persistence: drop Authorization, Cookie, Set-Cookie, passwords, MFA codes, OAuth codes, CSRF tokens, bearer strings, secret signed-URL params. Safe URL ref `{host,path,query_key_set,query_hash,expiry_class}`.
- Partition dirs not SQLCipher-protected — FS perms + FileVault residual protection, explicitly documented.
