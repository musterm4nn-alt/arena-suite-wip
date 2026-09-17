# ADR-0002: Passive CDP observation first; no production network patching

- **Status:** accepted (from master plan §2.5, §6)
- **Context:** Production capture must not alter Arena's networking semantics.
- **Decision:** Primary witness is passive `Network.*` + `Target`/`Runtime`
  observation with early `streamResourceContent` + `getResponseBody`
  reconciliation; isolated-world DOM witness covers UI-only facts. `Fetch`
  interception only for a qualified payload family after passive capture is
  proven insufficient. No page-world monkey-patching, no default service-worker
  bypass (diagnostic experiment only), no always-on proxy.
- **Consequences:** Some payload families may carry explicit coverage gaps
  until a gated fallback is measured and justified.
