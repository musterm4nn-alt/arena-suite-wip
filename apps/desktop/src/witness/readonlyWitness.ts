/**
 * Read-only isolated-world witness — installed by CDP, worldName="arena-archive"
 * Records only UI facts unavailable or more authoritative in rendered state:
 * route/conversation reference, participant positions, blind labels, selected labels,
 * visible vote state, reveal banners, stop/error state and UI ordering.
 * Sends typed observations through one binding and has no privileged return channel.
 * DOM selectors are versioned adapters with their own drift counters.
 */

export const WITNESS_SCRIPT = `
(() => {
  'use strict';
  // Isolated world — no access to page's JS, only DOM
  const BINDING = '__ARENA_ARCHIVE__';
  const VERSION = '1.0.0';

  /** @type {Map<string, number>} */
  const driftCounters = new Map();

  function sendObservation(type, data) {
    try {
      if (typeof window[BINDING] === 'function') {
        window[BINDING](JSON.stringify({
          v: VERSION,
          type,
          data,
          ts: Date.now(),
          url: location.href,
        }));
      }
    } catch (e) {
      // No privileged return channel — swallow
    }
  }

  function safeQuery(selector, version) {
    try {
      const el = document.querySelector(selector);
      if (!el) {
        const key = selector + ':' + version;
        driftCounters.set(key, (driftCounters.get(key) || 0) + 1);
        if (driftCounters.get(key) % 100 === 0) {
          sendObservation('drift', { selector, version, count: driftCounters.get(key) });
        }
      }
      return el;
    } catch {
      return null;
    }
  }

  function observeRoute() {
    // Route/conversation reference
    const path = location.pathname;
    const match = path.match(/\\/c\\/([a-zA-Z0-9_-]+)/);
    if (match) {
      sendObservation('route', { conversation_id: match[1], path });
    }
  }

  function observeVoteState() {
    // Blind labels, selected labels, visible vote state, reveal banners
    const selectors = {
      blindLabel: '[data-testid="blind-label"], [data-blinds]',
      selectedLabel: '[data-selected-model], [data-testid="selected-label"]',
      voteState: '[data-vote-state], [data-testid="vote"]',
      revealBanner: '[data-reveal], [data-testid="reveal-banner"]',
      stopState: '[data-stop], [data-testid="stop"]',
    };
    const result = {};
    for (const [k, sel] of Object.entries(selectors)) {
      const el = safeQuery(sel, VERSION);
      if (el) {
        result[k] = el.textContent?.slice(0, 500) || el.getAttribute('data-value') || 'present';
      }
    }
    if (Object.keys(result).length > 0) {
      sendObservation('ui_state', result);
    }
  }

  // Initial + mutation observer
  observeRoute();
  observeVoteState();

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      observeRoute();
    }
    observeVoteState();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  // No filesystem, no DB, no key access, no MCP access — read-only
})();
`;

export const WITNESS_WORLD_NAME = 'arena-archive';
export const WITNESS_BINDING_NAME = '__ARENA_ARCHIVE__';
