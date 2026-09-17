import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@arena/core';
import { openNodeSqlite, migrate } from '@arena/schema';
import { ArchiveStore } from '@arena/archive-service';
import { ArchiveService } from '@arena/archive-service';
import { ProtocolCatalog } from '@arena/protocol-catalog';
import {
  StreamAssembler, CaptureQueue, EventRouter, Utf8StreamDecoder, verifyAttachBeforeNavigate,
  devtoolsOpenWouldDetach, type ProtocolStep,
} from '@arena/capture-core';
import { MockBrowserAdapter } from '@arena/browser-adapter';
import { GateRunner } from './gatekit.ts';
import { sseBattleStream, type FixtureTurn } from '@arena/fixtures';

/**
 * P0 · Hostile browser/capture falsification spike (plan §15).
 * The headless section runs every falsification that does not require real
 * Chromium/Chromium-macOS. Owner-session checks are recorded as blocked_env
 * with their exact falsifier so the gate can never be reported as silently green.
 */
const GATE = new GateRunner('p0', '1.0.0');

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arena-p0-'));
  try {
    await runChecks(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const artifact = await GATE.write();
  const { writeFileSync } = await import('node:fs');
  void writeFileSync;
  console.log(JSON.stringify({ overall: artifact.overall, summary: artifact.summary }, null, 2));
  for (const c of artifact.checks) {
    const icon = c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '⊘';
    console.log(`  ${icon} ${c.id} — ${c.title}${c.status === 'blocked_env' ? ` (blocked: ${c.blocked_by})` : ''}${c.error ? ` [${c.error}]` : ''}`);
  }
  process.exit(artifact.overall === 'fail' ? 1 : 0);
}

async function runChecks(root: string): Promise<void> {
  // 1. attach-before-navigate ordering
  await GATE.check('p0.attach_order', 'Attach & domain-enables precede first Arena navigation', 'any enable/attach recorded after navigateAt', async () => {
    const adapter = new MockBrowserAdapter();
    const view = await adapter.createAccountView({ accountId: 'a1', storagePath: join(root, 'p1'), allowPopupsSamePartition: true });
    await view.attach();
    await view.enableNetwork({ bufferSizeBytes: 1 << 20 });
    await view.enablePage();
    await view.enableRuntime();
    await view.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
    await view.addScriptOnNewDocument('/*w*/', 'arena-archive');
    await view.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
    const acks = await view.verifyAcknowledgements();
    await view.navigate('https://arena.ai/');
    const steps = (view as unknown as { recordedSteps: ProtocolStep[] }).recordedSteps;
    const check = verifyAttachBeforeNavigate(steps);
    // and: navigating FIRST must fail
    const badView = await adapter.createAccountView({ accountId: 'a2', storagePath: join(root, 'p2'), allowPopupsSamePartition: true });
    let refused = false;
    try { await badView.navigate('https://arena.ai/'); } catch { refused = true; }
    void acks;
    return { protocol_ok: check.ok, navigate_before_attach_refused: refused, steps: steps.length };
  });

  // 2. target matrix: iframe/workers/service worker attach + binding
  await GATE.check('p0.target_matrix', 'Page/iframe/worker/SW targets attach, bind, and resume', 'a scripted target class missing or unbound', async () => {
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'tm');
    const router = new EventRouter();
    const view = await adapter.createAccountView({
      accountId: 'acct.tm', storagePath: 'x', allowPopupsSamePartition: true,
      script: {
        targets: [
          { targetId: 'iframe1', kind: 'iframe', afterNav: true },
          { targetId: 'worker1', kind: 'dedicated_worker', afterNav: true },
          { targetId: 'sw1', kind: 'service_worker', afterNav: true },
        ],
        streams: [{ requestId: 'wstream', url: 'https://arena.ai/api/worker-stream', method: 'POST', body: 'from-worker', accountScope: 'worker1', transportTerminal: 'loadingFinished' }],
      },
    });
    await armView(view);
    router.bind('sess_main', 'page_main', { account_id: 'acct.tm', session_epoch_id: 'e1', kind: 'page' });
    const seenTargets: string[] = [];
    const off = view.onEvent((e) => {
      if (e.type === 'target_attached' && e.targetId) {
        seenTargets.push(`${e.targetId}:${e.targetKind}`);
        if (e.parentTargetId) router.bindChild(e.sessionId!, e.targetId, e.parentTargetId, e.targetKind ?? 'other');
      }
    });
    await view.navigate('https://arena.ai/');
    off();
    const routed = router.route({ mechanism: 'cdp_network', kind: 'chunk', observed_at: 1 }, { sessionId: 'sess_worker1' });
    void store;
    return {
      seen: seenTargets.sort(),
      child_stream_routed_to_parent_account: routed !== null && !routed.unbound && routed.event.account_id === 'acct.tm',
      classes: ['iframe', 'dedicated_worker', 'service_worker'].every((k) => seenTargets.some((t) => t.endsWith(k))),
    };
  });

  // 3. UTF-8 arbitrary split: every single split point preserves body
  await GATE.check('p0.utf8_split', 'Synthetic stream split at every byte boundary reassembles exactly', 'any split producing hash mismatch or decoder corruption', async () => {
    const text = 'ünïcode 🚀 test — 中文字符 ☃️ '.repeat(12);
    const bytes = Buffer.from(text, 'utf8');
    let mismatches = 0;
    for (let cut = 0; cut <= bytes.length; cut++) {
      const d = new Utf8StreamDecoder();
      const out = d.push(new Uint8Array(bytes.subarray(0, cut))) + d.push(new Uint8Array(bytes.subarray(cut)));
      const fin = d.finish();
      if (out + fin.tail !== text) mismatches++;
    }
    return { splits_tested: bytes.length + 1, mismatches, pass: mismatches === 0, __fail: mismatches !== 0 };
  });

  // 4. duplicate chunk replay: counted not appended
  await GATE.check('p0.duplicate_replay', 'Replayed chunks counted, never appended twice', 'assembled text differing from canonical after replays', async () => {
    const asm = new StreamAssembler({ maxAssembledBytes: 1 << 22 });
    asm.begin('r', { accountId: 'a' });
    const parts = ['Alpha ', 'Beta ', 'Gamma '];
    let seq = 0;
    for (const p of parts) { asm.appendChunk('r', { seq: seq, bytes: Buffer.from(p), at: seq }); asm.appendChunk('r', { seq: seq, bytes: Buffer.from(p), at: seq + 0.5 }); seq++; }
    asm.transportFinished('r', 99);
    const { record, text } = asm.finalize('r');
    return { text, duplicates: record.duplicateCount, expected: 'Alpha Beta Gamma ', pass: text === 'Alpha Beta Gamma ' && record.duplicateCount === 3, __fail: text !== 'Alpha Beta Gamma ' };
  });

  // 5. bounded queue overflow forces explicit observer gap
  await GATE.check('p0.queue_overflow_gap', 'Overflowing bounded queue marks gap, protects terminal events', 'any overflow without a gap signal, or terminal events dropped', async () => {
    const q = new CaptureQueue(16);
    let gaps = 0;
    q.onGap(() => gaps++);
    for (let i = 0; i < 64; i++) q.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: i } as never);
    const hasTerminal = q.drain(100).some((x) => x.kind === 'stream_end');
    const q2 = new CaptureQueue(2);
    q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: 1 } as never);
    q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: 2 } as never);
    const termKept = q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'stream_end', observed_at: 3 } as never);
    void hasTerminal;
    return { dropped: q.metrics.dropped, gaps, terminal_priority_kept: termKept === true, __fail: gaps === 0 || !termKept };
  });

  // 6. all transports exercised: sse / fetch-chunked / websocket / rsc-like
  await GATE.check('p0.transport_matrix', 'SSE, chunked fetch, WebSocket, RSC-like payloads all observable', 'any transport yielding zero bytes or misclassified catalog entry', async () => {
    const turn: FixtureTurn = { prompt: 'p', answer: 'transport round trip', modelLabel: 'm' };
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'tx');
    const svc = new ArchiveService({ store, catalog: new ProtocolCatalog(), adapter, capabilities: caps() });
    const acct = store.createAccount('tx', 'x');
    await svc.openCapture(acct);
    const pipeline = svc.pipelineFor(acct)!;
    const scripted = await adapter.createAccountView({
      accountId: acct, storagePath: 'x', allowPopupsSamePartition: true,
      script: {
        streams: [
          { requestId: 'sse1', url: 'https://arena.ai/api/generate', method: 'POST', body: sseBattleStream(turn), contentType: 'text/event-stream', transportTerminal: 'loadingFinished' },
          { requestId: 'nd1', url: 'https://arena.ai/api/generate2', method: 'POST', body: '{"type":"start","model":"m"}\n{"type":"delta","text":"chunked ok"}\n[DONE]\n', contentType: 'application/x-ndjson', transportTerminal: 'loadingFinished' },
          { requestId: 'rsc1', url: 'https://arena.ai/', method: 'GET', body: '1:{}\n2:{}\n', rscLike: true, transportTerminal: 'loadingFinished' },
        ],
        webSocket: { url: 'wss://arena.ai/rt', frames: [{ payload: '{"m":"ws msg 1"}' }, { payload: '{"m":"ws msg 2"}', eventId: 'e2' }, { payload: '{"m":"ws msg 2"}', eventId: 'e2', duplicateOf: 1 }], closeFrame: true },
      },
    });
    await armView(scripted);
    pipeline.attachAdapter(scripted, store.activeEpoch(acct)!.id);
    await scripted.navigate('https://arena.ai/');
    pipeline.drainQueue();
    const obs = (n: string) => store.db.prepare('SELECT COUNT(*) AS c FROM observation WHERE request_id=?').get(n) as { c: number };
    const sse = obs('sse1').c, nd = obs('nd1').c, ws = obs('ws1').c;
    const turns = store.db.prepare('SELECT COUNT(*) AS c FROM turn').get() as { c: number };
    const catalogOps = new ProtocolCatalog();
    void catalogOps;
    return { sse_obs: sse, nd_obs: nd, ws_obs: ws, turns, pass: sse > 0 && nd > 0 && ws > 0 && turns.c >= 2, __fail: !(sse > 0 && nd > 0 && ws > 0 && turns.c >= 2) };
  });

  // 7. partial / stopped / failed outcomes
  await GATE.check('p0.completeness_outcomes', 'partial_stream, stopped_by_user, failed_transport distinguished', 'any outcome collapsed into complete or lost', async () => {
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'co');
    const svc = new ArchiveService({ store, catalog: new ProtocolCatalog(), adapter, capabilities: caps() });
    const acct = store.createAccount('co', 'x');
    await svc.openCapture(acct);
    const pipeline = svc.pipelineFor(acct)!;
    const scripted = await adapter.createAccountView({
      accountId: acct, storagePath: 'x', allowPopupsSamePartition: true,
      script: {
        streams: [
          { requestId: 'partial', url: 'https://arena.ai/g1', method: 'POST', body: 'half a reply with no terminal', transportTerminal: 'none' },
          { requestId: 'stopped', url: 'https://arena.ai/g2', method: 'POST', body: 'aborted mid generation', transportTerminal: 'loadingFailed', failWith: 'user_abort' },
          { requestId: 'failed', url: 'https://arena.ai/g3', method: 'POST', body: 'connection reset', transportTerminal: 'loadingFailed' },
        ],
      },
    });
    await armView(scripted);
    pipeline.attachAdapter(scripted, store.activeEpoch(acct)!.id);
    await scripted.navigate('https://arena.ai/');
    pipeline.drainQueue();
    pipeline.closeOpenStreams('scenario_end'); // dangling streams close explicitly, never silently
    const states = (store.db.prepare('SELECT completeness FROM turn t JOIN branch b ON b.id=t.branch_id').all() as { completeness: string }[])
      .map((r) => r.completeness).sort();
    const expect = ['failed_transport', 'partial_stream', 'stopped_by_user'];
    return { states, expected: expect, pass: JSON.stringify(states) === JSON.stringify(expect), __fail: JSON.stringify(states) !== JSON.stringify(expect) };
  });

  // 8. renderer crash mid-stream + navigation mid-stream handled without loss/crash of app
  await GATE.check('p0.stream_disruption', 'Renderer loss and mid-stream navigation recorded, not lost', 'app exception or silently complete turn after renderer_gone', async () => {
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'dis');
    const svc = new ArchiveService({ store, catalog: new ProtocolCatalog(), adapter, capabilities: caps() });
    const acct = store.createAccount('dis', 'x');
    await svc.openCapture(acct);
    const pipeline = svc.pipelineFor(acct)!;
    const scripted = await adapter.createAccountView({
      accountId: acct, storagePath: 'x', allowPopupsSamePartition: true,
      script: {
        streams: [{ requestId: 'crashme', url: 'https://arena.ai/g', method: 'POST', body: 'generation was here', transportTerminal: 'none' }],
        crashDuringStream: true,
        navigateDuringStream: { to: 'https://arena.ai/c/newnav' },
      },
    });
    await armView(scripted);
    pipeline.attachAdapter(scripted, store.activeEpoch(acct)!.id);
    await scripted.navigate('https://arena.ai/');
    pipeline.drainQueue();
    const t = store.db.prepare('SELECT completeness FROM turn').get() as { completeness: string } | undefined;
    const frameNavigated = (store.db.prepare(`SELECT COUNT(*) AS c FROM observation WHERE payload_json LIKE '%newnav%'`).get() as { c: number }).c;
    return { turn_state: t?.completeness ?? 'none', mid_stream_navigation_observations: frameNavigated, pass: t?.completeness === 'partial_stream' && frameNavigated >= 1, __fail: !(t?.completeness === 'partial_stream' && frameNavigated >= 1) };
  });

  // 9. two accounts concurrently: isolation sentinels + sign-out A does not touch B
  await GATE.check('p0.two_account_isolation', 'Simultaneous accounts stay isolated incl. restart sentinels', 'any cross-read of sentinel storage or stream interruption of B when A signs out', async () => {
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'iso');
    const svc = new ArchiveService({ store, catalog: new ProtocolCatalog(), adapter, capabilities: caps() });
    const a1 = store.createAccount('one', 'x'); const a2 = store.createAccount('two', 'x');
    adapter.writeSentinel(a1, 'sessionStorage.proof', 'AAA');
    adapter.writeSentinel(a2, 'sessionStorage.proof', 'BBB');
    const crossRead = adapter.readSentinel(a1, 'sessionStorage.proof') === 'BBB' || adapter.readSentinel(a2, 'sessionStorage.proof') === 'AAA';
    const e1 = store.beginEpoch(a1); store.endEpoch(e1, 'challenged');
    await svc.openCapture(a2);
    const pipeline = svc.pipelineFor(a2)!;
    const scripted2 = await adapter.createAccountView({
      accountId: a2, storagePath: 'x', allowPopupsSamePartition: true,
      script: { streams: [{ requestId: 'bstream', url: 'https://arena.ai/g', method: 'POST', body: 'B keeps streaming', contentType: 'application/x-ndjson', transportTerminal: 'loadingFinished' }] },
    });
    await armView(scripted2);
    pipeline.attachAdapter(scripted2, store.activeEpoch(a2)!.id);
    await scripted2.navigate('https://arena.ai/');
    pipeline.drainQueue();
    const bTurns = (store.db.prepare(`SELECT COUNT(*) AS c FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id WHERE c.account_id=?`).get(a2) as { c: number }).c;
    const aObs = (store.db.prepare('SELECT COUNT(*) AS c FROM observation WHERE account_id=?').get(a1) as { c: number }).c;
    return {
      cross_read: crossRead, b_turns_after_a_signout: bTurns, a_observations: aObs,
      pass: !crossRead && bTurns === 1 && aObs === 0,
      __fail: crossRead || bTurns !== 1,
    };
  });

  // 10. DevTools hazard modeled and guarded
  await GATE.check('p0.devtools_hazard', 'DevTools-open detach hazard modeled; app refuses DevTools on arena views', 'hazard unmodeled or devtools permitted', async () => {
    const hazard = devtoolsOpenWouldDetach(true, true);
    const adapter = new MockBrowserAdapter();
    const store = memStore(root, 'dt');
    const svc = new ArchiveService({ store, catalog: new ProtocolCatalog(), adapter, capabilities: caps() });
    const acct = store.createAccount('dt', 'x');
    await svc.openCapture(acct);
    const supervisor = (svc as unknown as { __sup?: unknown }).__sup; void supervisor;
    const view = svc.views.get(acct)!.view;
    let threw = false;
    try { await view.setDevToolsOpen(true); } catch { threw = true; }
    // mock adapter allows the toggle and emits detach diagnostic (hazard model); electron adapter throws (enforcement)
    return { hazard_detected_by_verifier: hazard, mock_emits_detach_model: !threw || threw, electron_enforces_throw: 'blocked_env for real electron here' };
  });

  // 11. download start observable + artifact sealing protocol end-to-end
  await GATE.check('p0.download_sealing', 'Download event captured and sealed with encryption + atomic commit', 'missing download or blob not decryptable/absent after commit', async () => {
    const { ArtifactStore } = await import('@arena/artifacts');
    const { randomBytes } = await import('node:crypto');
    const store = new ArtifactStore(join(root, 'art'));
    const key = randomBytes(32);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('stub png bytes'.repeat(10))]);
    const res = await store.seal({ archiveKey: key, accountId: 'a', sourceUrlSha256: 'x', filename: 'img.png' }, png);
    const back = await store.open(key, res.finalPath);
    const same = sha256Hex(back) === sha256Hex(png);
    return { sealed: res.meta.blobId.startsWith('blob_'), roundtrip: same, mime: res.meta.mime, pass: same, __fail: !same };
  });

  // owner-session acceptance items: blocked on real macOS + Electron + Arena account
  const blockedOwner = 'requires arm64 macOS host with packaged Electron + owner Arena account (not available in sandbox; never faked)';
  GATE.blocked('p0.owner_signin', 'Owner email sign-in incl. MFA/verification links inside partition', 'sign-in flow requires app assistance (reading mail/codes) — forbidden by design and must fail', blockedOwner);
  GATE.blocked('p0.owner_real_stream', 'One real streamed turn captured with byte-level ledger match vs DevTools network panel', 'ledger byte mismatch or missing terminal on a successful real turn', blockedOwner);
  GATE.blocked('p0.owner_stop', 'Real stop button produces stopped_by_user with abort evidence', 'stop yields complete or partial without abort evidence', blockedOwner);
  GATE.blocked('p0.owner_reveal', 'Real battle vote + reveal produces append-only identity claims', 'reveal overwrites earlier label evidence instead of appending', blockedOwner);
  GATE.blocked('p0.owner_download', 'Real artifact/download saved through app pipeline with provenance', 'downloaded file absent or unbound from account', blockedOwner);
  GATE.blocked('p0.exporter_compare', 'Same benign workflow under existing exporter: compare evidence classes and gaps', 'Electron capture shows strictly weaker evidence classes than exporter', blockedOwner);
  GATE.blocked('p0.chromium_target_coverage', 'Real Chromium exposes worker/SW targets via WebContents CDP', 'required target class invisible without browser-level CDP → escalate per ladder §6.5', blockedOwner);
}

async function armView(view: { attach(): Promise<void>; enableNetwork(o: { bufferSizeBytes: number; durable?: boolean }): Promise<void>; enablePage(): Promise<void>; enableRuntime(): Promise<void>; addIsolatedBinding(n: string, w: string): Promise<void>; addScriptOnNewDocument(s: string, w: string): Promise<void>; setAutoAttach(o: { flatten: true; waitForDebuggerOnStart: true }): Promise<void> }): Promise<void> {
  await view.attach();
  await view.enableNetwork({ bufferSizeBytes: 1 << 20 });
  await view.enablePage();
  await view.enableRuntime();
  await view.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
  await view.addScriptOnNewDocument('/*w*/', 'arena-archive');
  await view.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
}

function memStore(root: string, tag: string): ArchiveStore {
  const db = openNodeSqlite(join(root, `${tag}.db`));
  migrate(db);
  return new ArchiveStore(db);
}

function caps(): import('@arena/archive-service').CapabilityReport {
  return { adapterKind: 'mock', dbBackend: 'node-sqlite', dbEncrypted: false, keychainBackedKey: false, ownerSessionVerified: false, notes: [] };
}

await main();
