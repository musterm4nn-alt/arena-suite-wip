/**
 * Attach-before-navigate protocol verifier (plan §6.1). The ordering IS the
 * architecture: the gate asserts every enable/ack step completes before the
 * first Arena navigation request, and that flattening + waitForDebuggerOnStart
 * are configured so child targets cannot miss early traffic.
 */

export type ProtocolStep =
  | { step: 'create_account_view'; account_id: string; at: number }
  | { step: 'bind_account'; account_id: string; at: number }
  | { step: 'create_capture_queue'; account_id: string; at: number }
  | { step: 'debugger_attach'; account_id: string; at: number }
  | { step: 'domain_enable'; domain: 'Network' | 'Page' | 'Runtime'; ack: boolean; at: number }
  | { step: 'add_binding'; name: string; isolatedWorld: boolean; at: number }
  | { step: 'add_script_to_evaluate_on_new_document'; world: string; at: number }
  | { step: 'set_auto_attach'; autoAttach: true; flatten: true; waitForDebuggerOnStart: true; at: number }
  | { step: 'navigate'; url: string; at: number };

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** Protocol step before the `at` timestamp is attached. */
export type ProtocolStepInput = DistributiveOmit<ProtocolStep, 'at'>;

const REQUIRED_BEFORE_NAV = [
  'debugger_attach',
  'add_binding',
  'add_script_to_evaluate_on_new_document',
  'set_auto_attach',
] as const;

export interface ProtocolCheckResult {
  ok: boolean;
  failures: string[];
  measured: { navigateAt: number | null; firstNavWasArena: boolean; enabledDomains: string[] };
}

export function verifyAttachBeforeNavigate(steps: ProtocolStep[]): ProtocolCheckResult {
  const failures: string[] = [];
  const navIdx = steps.findIndex((s) => s.step === 'navigate');
  const nav = navIdx >= 0 ? steps[navIdx] : undefined;
  if (!nav || nav.step !== 'navigate') {
    return { ok: false, failures: ['no navigation recorded'], measured: { navigateAt: null, firstNavWasArena: false, enabledDomains: [] } };
  }
  for (const req of REQUIRED_BEFORE_NAV) {
    const idx = steps.findIndex((s) => s.step === req);
    if (idx === -1) failures.push(`missing required pre-navigation step: ${req}`);
    else if (idx > navIdx) failures.push(`step ${req} occurred AFTER navigation`);
  }
  // Network must be enabled (with ack) before navigation for first-request visibility.
  for (const dom of ['Network', 'Page', 'Runtime']) {
    const es = steps.filter((s): s is Extract<ProtocolStep, { step: 'domain_enable' }> => s.step === 'domain_enable' && s.domain === dom);
    if (es.length === 0) failures.push(`domain ${dom} not enabled`);
    else if (!es.some((e) => e.ack)) failures.push(`domain ${dom} enable lacks acknowledgement`);
    else if (es.every((e) => e.at > nav.at)) {
      failures.push(`domain ${dom} enabled after navigation`);
    }
  }
  const binding = steps.find((s) => s.step === 'add_binding');
  if (binding && binding.step === 'add_binding' && !binding.isolatedWorld) {
    failures.push('Runtime.addBinding must be isolated-world only');
  }
  const auto = steps.find((s) => s.step === 'set_auto_attach');
  if (auto && auto.step === 'set_auto_attach' && !(auto.autoAttach && auto.flatten && auto.waitForDebuggerOnStart)) {
    failures.push('autoAttach/flatten/waitForDebuggerOnStart must all be true');
  }
  const firstUrl = nav.url;
  const firstNavWasArena = /^https:\/\/arena\.ai\//.test(firstUrl);
  if (!firstNavWasArena) failures.push(`first navigation was not https://arena.ai/ (was ${firstUrl})`);
  // Ordering within pre-nav group: attach before enable+scripts.
  const attachIdx = steps.findIndex((s) => s.step === 'debugger_attach');
  const enableIdx = steps.findIndex((s) => s.step === 'domain_enable');
  if (enableIdx !== -1 && attachIdx !== -1 && enableIdx < attachIdx) failures.push('domain_enable before debugger_attach');
  // §6.1 order: create view -> bind account -> create bounded queue -> attach.
  const queueIdx = steps.findIndex((s) => s.step === 'create_capture_queue');
  const bindIdx = steps.findIndex((s) => s.step === 'bind_account');
  if (queueIdx === -1) failures.push('missing required pre-navigation step: create_capture_queue');
  else {
    if (bindIdx !== -1 && queueIdx < bindIdx) failures.push('capture queue created before account binding');
    if (queueIdx > navIdx) failures.push('capture queue created after navigation');
  }
  return {
    ok: failures.length === 0,
    failures,
    measured: {
      navigateAt: nav.at,
      firstNavWasArena,
      enabledDomains: steps.filter((s) => s.step === 'domain_enable').map((s) => (s as Extract<ProtocolStep, { step: 'domain_enable' }>).domain),
    },
  };
}

/** DevTools on Arena WebContents can detach Electron's debugger (plan §6.1): refuse it. */
export function devtoolsOpenWouldDetach(devtoolsOpen: boolean, debuggerAttached: boolean): boolean {
  return devtoolsOpen && debuggerAttached;
}
