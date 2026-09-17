/**
 * Attach-before-navigate protocol (plan §6.1) as a verifiable step list.
 *
 * The Electron implementation executes these steps via debugger.attach();
 * the P0 gate asserts the ORDER (attach+enable ACKs before first Arena
 * request) using the recorded step log — against the fake here, and against
 * the real shell on macOS.
 */

export const ATTACH_STEPS = [
  "create-webcontents-no-url",
  "bind-webcontents-account",
  "create-capture-queue",
  "debugger-attach",
  "network-enable",
  "page-enable",
  "runtime-enable",
  "runtime-add-binding",
  "page-add-script-isolated-world",
  "target-set-autoattach",
  "verify-acknowledgements",
  "navigate-arena",
] as const;

export type AttachStep = (typeof ATTACH_STEPS)[number];

/** Returns null when the log satisfies the protocol, else the violation. */
export function verifyAttachOrder(log: readonly string[]): string | null {
  const idx = new Map<string, number>();
  log.forEach((s, i) => {
    if (!idx.has(s)) idx.set(s, i);
  });
  for (const step of ATTACH_STEPS) {
    if (!idx.has(step)) return `missing step: ${step}`;
  }
  for (let i = 1; i < ATTACH_STEPS.length; i++) {
    const prev = idx.get(ATTACH_STEPS[i - 1]!)!;
    const cur = idx.get(ATTACH_STEPS[i]!)!;
    if (!(prev < cur)) {
      return `order violation: ${ATTACH_STEPS[i - 1]} must precede ${ATTACH_STEPS[i]}`;
    }
  }
  return null;
}
