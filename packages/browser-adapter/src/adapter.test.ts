import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBrowserAdapter } from './index.ts';
import { verifyAttachBeforeNavigate, type ProtocolStep } from '@arena/capture-core';
import type { AdapterEvent } from './adapter.ts';

async function armedView(adapter: MockBrowserAdapter, accountId: string, script?: ViewScriptArg) {
  const view = await adapter.createAccountView({ accountId, storagePath: `/tmp/p/${accountId}`, allowPopupsSamePartition: true, script });
  await view.attach();
  await view.enableNetwork({ bufferSizeBytes: 1 << 20 });
  await view.enablePage();
  await view.enableRuntime();
  await view.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
  await view.addScriptOnNewDocument('/*witness*/', 'arena-archive');
  await view.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
  return view;
}
type ViewScriptArg = import('./mock-adapter.ts').ViewScript;

test('mock view records a valid attach-before-navigate protocol', async () => {
  const adapter = new MockBrowserAdapter();
  const view = await armedView(adapter, 'acct-1', {
    streams: [{ requestId: 'r1', url: 'https://arena.ai/api/stream', method: 'POST', body: 'hello world', transportTerminal: 'loadingFinished' }],
  });
  const acks = await view.verifyAcknowledgements();
  assert.deepEqual(acks.missing, []);
  await view.navigate('https://arena.ai/');
  const steps = (view as unknown as { recordedSteps: ProtocolStep[] }).recordedSteps;
  const check = verifyAttachBeforeNavigate(steps);
  assert.equal(check.ok, true, JSON.stringify(check.failures));
  const events = (view as unknown as { recordedEvents: AdapterEvent[] }).recordedEvents;
  assert.ok(events.some((e) => e.type === 'cdp' && e.cdp?.method === 'Network.dataReceived'));
});

test('mock refuses enable before attach and non-arena navigation', async () => {
  const adapter = new MockBrowserAdapter();
  const view = await adapter.createAccountView({ accountId: 'a', storagePath: '/tmp', allowPopupsSamePartition: true });
  await assert.rejects(() => view.enablePage(), /requires debugger attachment/);
  await view.attach();
  await view.enablePage();
  await assert.rejects(() => view.navigate('https://evil.example/'), /blocked/);
});

test('mock refuses new-document script outside the isolated world', async () => {
  const adapter = new MockBrowserAdapter();
  const view = await adapter.createAccountView({ accountId: 'a', storagePath: '/tmp', allowPopupsSamePartition: true });
  await view.attach();
  await assert.rejects(() => view.addScriptOnNewDocument('x', ''), /arena-archive/);
});

test('devtools-open hazard model: open after attach emits detach diagnostic', async () => {
  const adapter = new MockBrowserAdapter();
  const view = await adapter.createAccountView({ accountId: 'a', storagePath: '/tmp', allowPopupsSamePartition: true });
  await view.attach();
  await view.setDevToolsOpen(true);
  const events = (view as unknown as { recordedEvents: AdapterEvent[] }).recordedEvents;
  assert.ok(events.some((e) => e.type === 'diagnostic' && (e.detail?.code === 'debugger_detached' || e.detail?.code === 'attach_refused_devtools')));
});
