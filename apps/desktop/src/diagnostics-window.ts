/**
 * Diagnostics window — separate from Arena WebContents per §4
 * DevTools on Arena WebContents is prohibited because it can detach Electron's debugger.
 * Provide separate diagnostics window and capture harness instead.
 */

export interface DiagnosticsData {
  accounts: { id: string; partition_path: string; epoch: string }[];
  target_matrix: Record<string, boolean>;
  attach_ordering: { attachTimestamp: number; firstRequestTimestamp?: number; orderingValid: boolean };
  archive_metrics: { observations: number; conversations: number; turns: number; accounts: number };
  protocol_ops: number;
  drift_events: number;
  queue_metrics: any;
  ledger_metrics: any;
}

export function renderDiagnosticsHtml(data: DiagnosticsData): string {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Arena Archive Diagnostics</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline';">
    <style>
      body { font-family: -apple-system, system-ui, monospace; margin: 20px; background: #0a0a0a; color: #e0e0e0; }
      h1 { color: #fff; }
      .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 12px 0; }
      .ok { color: #4ade80; }
      .warn { color: #facc15; }
      .fail { color: #f87171; }
      pre { background: #000; padding: 12px; overflow: auto; border-radius: 4px; }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid #333; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <h1>Arena Archive — Diagnostics (P0/P1)</h1>
    <p>DevTools on Arena WebContents is prohibited. This window is separate.</p>

    <div class="card">
      <h2>Accounts (${data.accounts.length})</h2>
      <table>
        <tr><th>ID</th><th>Partition</th><th>Epoch</th></tr>
        ${data.accounts.map(a => `<tr><td>${a.id}</td><td>${a.partition_path}</td><td>${a.epoch}</td></tr>`).join("")}
      </table>
    </div>

    <div class="card">
      <h2>Attach Ordering Proof</h2>
      <p class="${data.attach_ordering.orderingValid ? 'ok' : 'fail'}">Ordering valid: ${data.attach_ordering.orderingValid}</p>
      <pre>attachTs: ${data.attach_ordering.attachTimestamp}
firstRequestTs: ${data.attach_ordering.firstRequestTimestamp}
delta: ${(data.attach_ordering.firstRequestTimestamp ?? 0) - data.attach_ordering.attachTimestamp}ms</pre>
      <p>Per §6.1: attach/domain-enable must occur before first Arena navigation request.</p>
    </div>

    <div class="card">
      <h2>Target Matrix</h2>
      <table>
        <tr><th>Type</th><th>Observed</th></tr>
        ${Object.entries(data.target_matrix).map(([k,v]) => `<tr><td>${k}</td><td class="${v ? 'ok' : 'fail'}">${v}</td></tr>`).join("")}
      </table>
      <p>Per P0: page, iframe, dedicated worker, shared worker, service-worker creation exercised; freeze/arm/resume child targets.</p>
    </div>

    <div class="card">
      <h2>Archive Metrics</h2>
      <pre>${JSON.stringify(data.archive_metrics, null, 2)}</pre>
    </div>

    <div class="card">
      <h2>Protocol Catalog</h2>
      <p>Ops: ${data.protocol_ops}, Drift: ${data.drift_events}</p>
      <p>Per §8: Unknown ops stay unknown, read-only earned via probe, RSC first-class, drift explicit, fail closed.</p>
    </div>

    <div class="card">
      <h2>Queue & Ledger</h2>
      <h3>Queue</h3><pre>${JSON.stringify(data.queue_metrics, null, 2)}</pre>
      <h3>Ledger</h3><pre>${JSON.stringify(data.ledger_metrics, null, 2)}</pre>
    </div>

    <div class="card">
      <h2>Capture Harness</h2>
      <p>For P0: exercise streamed fetch, SSE, WebSocket, RSC-like, partial/stopped/failed, download start, UTF-8 boundaries, duplicate chunks, queue overflow.</p>
      <p>See <code>artifacts/gates/p0.json</code> for machine-readable evidence.</p>
    </div>

    <div class="card">
      <h2>MCP Capabilities (mock)</h2>
      <pre>{
  "version": "0.1.0-p0",
  "capabilities": {
    "capture": true,
    "multiAccount": true,
    "targetCoverage": {
      "page": true,
      "iframe": true,
      "dedicated_worker": true,
      "shared_worker": "needs_browser_cdp_fallback_in_real_electron",
      "service_worker": "needs_verification"
    }
  }
}</pre>
      <p>Recommended first MCP call: <code>diagnostics_capabilities</code></p>
    </div>

  </body>
  </html>
  `;
}
