/**
 * Isolated-world DOM witness (plan §6.4).
 *
 * Read-only, installed via CDP Page.addScriptToEvaluateOnNewDocument into a
 * dedicated world ("arena-archive"). One binding (__ARENA_ARCHIVE__) carries
 * TYPED observations out; there is no privileged return channel. Removing the
 * witness must degrade only UI corroboration, never network capture.
 *
 * DOM selectors are versioned adapters with their own drift counters —
 * WITNESS_VERSION must bump whenever selectors change.
 */

export const WITNESS_WORLD = "arena-archive";
export const WITNESS_BINDING = "__ARENA_ARCHIVE__";
export const WITNESS_VERSION = "arena-dom@v0-p0";

/**
 * Source installed into the isolated world. Deliberately conservative: it
 * reports only coarse UI facts and never touches the network.
 */
export const WITNESS_SOURCE = `(() => {
  "use strict";
  const VERSION = ${JSON.stringify(WITNESS_VERSION)};
  const BINDING = ${JSON.stringify(WITNESS_BINDING)};
  const send = (obs) => {
    try {
      const fn = globalThis[BINDING];
      if (typeof fn === "function") fn(JSON.stringify({ version: VERSION, ...obs, observedAtMs: Date.now() }));
    } catch { /* witness never throws into the page */ }
  };
  const text = (el) => (el ? (el.innerText || "").slice(0, 200) : null);
  const snapshot = () => {
    let route = null;
    try { route = location.pathname + location.search; } catch { route = null; }
    // Coarse, versioned selectors. P0: presence-level facts only.
    const buttons = [...document.querySelectorAll("button")].slice(0, 200);
    const voteTokens = ["vote", "best", "tie", "both bad"];
    const voteState = buttons.some((b) => voteTokens.some((t) => (b.innerText || "").toLowerCase().includes(t)))
      ? "vote-visible" : "vote-unknown";
    send({ route, conversationRef: null, voteState, stopOrError: null, note: "p0-coarse" });
    void text;
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; try { snapshot(); } catch {} }, 2000);
  };
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* observe once below regardless */ }
  try { snapshot(); } catch {}
})();`;
