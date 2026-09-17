/**
 * Isolated-world rendered-state witness (plan §6.4). Read-only: it may ONLY
 * post typed observations through the Runtime.addBinding channel; there is no
 * return value, no privileged channel, nothing it can mutate. Removing it must
 * degrade only UI corroboration, never network capture.
 *
 * The source below is injected via Page.addScriptToEvaluateOnNewDocument with
 * worldName 'arena-archive'. Selectors live in a versioned adapter table so
 * drift is attributable (§8).
 */
export const WITNESS_VERSION = 1;

export const WITNESS_SOURCE = `(() => {
  const VERSION = ${WITNESS_VERSION};
  const send = (msg) => {
    try {
      if (typeof window.__ARENA_ARCHIVE__ === 'function') {
        window.__ARENA_ARCHIVE__.postMessage(JSON.stringify(msg));
      }
    } catch { /* never throw into page world */ }
  };
  const sel = {
    version: ${WITNESS_VERSION},
    route: ['[data-arena-route]'],
    participant: ['[data-arena-participant]'],
    blindLabel: ['[data-arena-blind-label]'],
    selectedLabel: ['[data-arena-selected-label]'],
    voteState: ['[data-arena-vote]'],
    reveal: ['[data-arena-reveal]'],
    stopError: ['[data-arena-stop]'],
  };
  const pick = (root, sels) => {
    for (const s of sels) { const el = root.querySelector(s); if (el) return el; }
    return null;
  };
  const readState = () => {
    const d = document;
    const out = { v: VERSION };
    const route = pick(d, sel.route);
    if (route) out.route = route.textContent.trim().slice(0, 2048);
    const conv = d.location.pathname.match(/^\\/c\\/([A-Za-z0-9_-]{1,128})/);
    if (conv) out.conversation_ref = conv[1];
    const parts = [...d.querySelectorAll('[data-arena-participant]')].slice(0, 8).map((el, i) => {
      const p = { position: Number(el.getAttribute('data-arena-position') ?? i) };
      const bl = pick(el, sel.blindLabel); if (bl) p.blind_label = bl.textContent.trim().slice(0, 64);
      const sl = pick(el, sel.selectedLabel); if (sl) p.selected_label = sl.textContent.trim().slice(0, 128);
      return p;
    });
    if (parts.length) out.participants = parts;
    const vote = pick(d, sel.voteState);
    if (vote) {
      const s = vote.getAttribute('data-arena-vote-positions') ?? '';
      out.vote = { selected_positions: s.split(',').filter(Boolean).map(Number).slice(0, 8), revealed: !!pick(d, sel.reveal) };
    }
    const rev = pick(d, sel.reveal);
    if (rev) out.reveal_banner = rev.textContent.trim().slice(0, 512);
    const stop = pick(d, sel.stopError);
    if (stop) out.stop_error_state = stop.getAttribute('data-arena-stop-state') ?? 'unknown';
    return out;
  };
  let lastJson = '';
  const emit = () => {
    try {
      const s = readState();
      const j = JSON.stringify(s);
      if (j !== lastJson) { lastJson = j; send(s); }
    } catch { /* swallow: witness must never break the page */ }
  };
  const mo = new MutationObserver(() => { /* debounce via microtask */ });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; emit(); }, 250);
  };
  const observe = () => {
    mo.disconnect();
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-arena-vote-positions', 'data-arena-stop-state'] });
    schedule();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe, { once: true });
  } else observe();
  window.addEventListener('popstate', schedule);
  mo.takeRecords(); // no-op read to keep observer alive cheaply
  void emit;
})();`;

/** The witness may never see or send these; tests assert schema-level rejection. */
export const WITNESS_FORBIDDEN_KEYS = ['fetch', 'xmlhttprequest', 'token', 'cookie', 'authorization', 'script', 'eval'];
