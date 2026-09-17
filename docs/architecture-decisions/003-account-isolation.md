# ADR 003: Simultaneous account isolation

- **Status:** Accepted
- **Context:** Need to support multiple Arena accounts simultaneously without cross-contamination, and ensure one account failing does not degrade another.
- **Decision:**
  - Each account is immutable local UUID, storage path Application Support/ArenaArchive/partitions/<account_uuid>/ — never derived from email, display names, Arena model labels or page data
  - One persistent Session per account: cookies, local/session storage, IndexedDB, HTTP cache, CacheStorage, SW registrations stay partition-scoped
  - Capture authority stamped by CaptureSupervisor that owns WebContents; page payloads cannot set account_id
  - Session epoch: every successful sign-in starts epoch; sign-out, identity mismatch, credential invalidation ends it
  - Sync: one queue, token bucket, cursor/checkpoint chain and auth state per account
  - Artifacts: initiating session determines artifact account before file linkage — same filename/source URL in two accounts remains two provenance records
  - Deletion: directive binds canonical account/conversation IDs and scope hash — A directive for A cannot delete B
- **Sign-in:** Owner-driven inside target Arena view, email verification links, codes, MFA, redirects, challenges handled interactively; app does not read mail or solve challenges. Popups required by flow remain in same partition. On challenge, only that account enters owner_action_required; automated traversal and sync pause while passive capture may continue. Do not import cookies from another browser. Do not store passwords, email codes, bearer tokens or copied session credentials in archive. Browser-managed partition state remains residual plaintext/browser-managed exposure protected by filesystem permissions and FileVault, not SQLCipher.
- **Validation:** Blocking tests — write unique sentinels in A/B and verify no cross-read after restart; fuzz page-supplied account-like fields and assert DB account remains supervisor-derived; sign out A while B streams; expire A during concurrent A+B sync; same filename in two accounts remains two provenance records; A directive cannot delete B.
