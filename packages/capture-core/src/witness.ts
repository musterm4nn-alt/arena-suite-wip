/**
 * Isolated-world witness — per §6.4
 * Records only UI facts unavailable or more authoritative in rendered state
 */

export const WITNESS_WORLD_NAME = "arena-archive";
export const WITNESS_BINDING_NAME = "__ARENA_ARCHIVE__";

export const WITNESS_SCRIPT = `
(() => {
  const BINDING = "__ARENA_ARCHIVE__";
  const VERSION = "witness-v1";
  let driftCounter = 0;

  function safeQuery(selector) {
    try {
      return document.querySelectorAll(selector);
    } catch (e) {
      driftCounter++;
      return [];
    }
  }

  function observe() {
    const route = location.pathname + location.search;
    const conversationRef = document.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id') || location.pathname.split('/').pop() || null;

    // Participant positions, blind labels, selected labels, vote state, reveal banners, stop/error, UI ordering
    // These selectors are versioned adapters with drift counters — per spec, selectors are adapters
    const participantEls = safeQuery('[data-participant-position], [data-testid*=\"participant\"], .participant');
    const blindLabelEls = safeQuery('[data-blind-label], [data-testid*=\"blind\"]');
    const selectedLabelEls = safeQuery('[data-selected-label], [data-testid*=\"selected-model\"]');
    const voteEls = safeQuery('[data-vote-state], [data-testid*=\"vote\"]');
    const revealEls = safeQuery('[data-reveal], [data-testid*=\"reveal\"], .reveal-banner');
    const stopEls = safeQuery('[data-stop-state], [data-testid*=\"stop\"], [data-error-state]');

    const payload = {
      v: VERSION,
      observed_at: new Date().toISOString(),
      route,
      conversation_ref: conversationRef,
      participant_positions: Array.from(participantEls).map((el, i) => {
        const pos = el.getAttribute('data-participant-position');
        return pos ? parseInt(pos, 10) : i;
      }),
      blind_labels: Array.from(blindLabelEls).map(el => el.textContent?.trim() || el.getAttribute('data-blind-label') || ''),
      selected_labels: Array.from(selectedLabelEls).map(el => el.textContent?.trim() || el.getAttribute('data-selected-label') || ''),
      vote_state: voteEls[0]?.textContent?.trim() || voteEls[0]?.getAttribute('data-vote-state') || null,
      reveal_banner: revealEls[0]?.textContent?.trim() || null,
      stop_error_state: stopEls[0]?.textContent?.trim() || stopEls[0]?.getAttribute('data-error-state') || null,
      ui_ordering: Array.from(document.querySelectorAll('[data-turn-id]')).map(el => el.getAttribute('data-turn-id') || ''),
      selector_version: VERSION,
      drift_counter: driftCounter,
    };

    try {
      // @ts-ignore
      if (window[BINDING]) {
        // @ts-ignore
        window[BINDING](JSON.stringify({ type: "witness_observation", payload }));
      }
    } catch {}
  }

  // Observe on load, route change, and periodically
  const observer = new MutationObserver(() => {
    observe();
  });

  function start() {
    observe();
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(observe, 2000);
    // Listen for SPA navigations
    const origPush = history.pushState;
    history.pushState = function(...args) {
      const ret = origPush.apply(this, args);
      setTimeout(observe, 100);
      return ret;
    };
    window.addEventListener('popstate', () => setTimeout(observe, 100));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`.trim();

export interface WitnessObservationPayload {
  v: string;
  observed_at: string;
  route: string;
  conversation_ref: string | null;
  participant_positions: number[];
  blind_labels: string[];
  selected_labels: string[];
  vote_state: string | null;
  reveal_banner: string | null;
  stop_error_state: string | null;
  ui_ordering: string[];
  selector_version: string;
  drift_counter: number;
}

export function parseWitnessMessage(json: string): { type: string; payload: WitnessObservationPayload } | null {
  try {
    const obj = JSON.parse(json);
    if (obj.type === "witness_observation" && obj.payload) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
