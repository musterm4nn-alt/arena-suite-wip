import { describe, expect, it } from "vitest";
import {
  deriveCompleteness,
  maybePromoteCompleteness,
} from "../src/completeness.js";

describe("deriveCompleteness", () => {
  it("requires positive terminal evidence for complete", () => {
    expect(
      deriveCompleteness({
        parserTerminal: true,
        transportTerminal: "loading_finished",
        observerGap: false,
        userStop: false,
        uiOnly: false,
        imported: false,
      }),
    ).toBe("complete");
  });

  it("never completes with an observer gap, even with terminal evidence", () => {
    expect(
      deriveCompleteness({
        parserTerminal: true,
        transportTerminal: "loading_finished",
        observerGap: true,
        userStop: false,
        uiOnly: false,
        imported: false,
      }),
    ).toBe("observer_gap");
  });

  it("maps transport close without terminal record to partial_stream", () => {
    expect(
      deriveCompleteness({
        parserTerminal: false,
        transportTerminal: "transport_close",
        observerGap: false,
        userStop: false,
        uiOnly: false,
        imported: false,
      }),
    ).toBe("partial_stream");
  });

  it("maps user stop / transport failure explicitly", () => {
    const base = {
      parserTerminal: false,
      transportTerminal: null,
      observerGap: false,
      userStop: true,
      uiOnly: false,
      imported: false,
    } as const;
    expect(deriveCompleteness(base)).toBe("stopped_by_user");
    expect(
      deriveCompleteness({ ...base, userStop: false, transportTerminal: "loading_failed" }),
    ).toBe("failed_transport");
  });

  it("keeps unknown unknown", () => {
    expect(
      deriveCompleteness({
        parserTerminal: false,
        transportTerminal: null,
        observerGap: false,
        userStop: false,
        uiOnly: false,
        imported: false,
      }),
    ).toBe("unknown");
  });

  it("promotes partial only with same-scope reconciled coverage", () => {
    expect(
      maybePromoteCompleteness({
        current: "partial_stream",
        sameScope: true,
        contentReconciled: true,
        gapCovered: true,
      }),
    ).toBe("complete");
    expect(
      maybePromoteCompleteness({
        current: "partial_stream",
        sameScope: true,
        contentReconciled: true,
        gapCovered: false,
      }),
    ).toBe("partial_stream");
    // complete is never demoted by this path; unknown never promoted.
    expect(
      maybePromoteCompleteness({
        current: "unknown",
        sameScope: true,
        contentReconciled: true,
        gapCovered: true,
      }),
    ).toBe("unknown");
  });
});
