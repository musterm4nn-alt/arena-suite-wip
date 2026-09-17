import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_GATED_TOOLS,
  TOOL_NAMES,
  ToolSchemas,
  parseToolInput,
} from "../src/index.js";

describe("mcp-contract", () => {
  it("exposes the full plan §12.1 inventory (no silent drift)", () => {
    const expected = [
      "accounts_list",
      "accounts_get",
      "accounts_begin_signin",
      "accounts_identity_probe",
      "accounts_set_enabled",
      "capture_status",
      "capture_pause",
      "capture_resume",
      "capture_stop_all",
      "capture_completeness",
      "capture_repair",
      "sync_start",
      "sync_status",
      "sync_pause",
      "sync_cancel",
      "sync_resume",
      "sync_coverage",
      "sync_verify_read",
      "archive_search",
      "archive_get_conversation",
      "archive_get_turn",
      "archive_get_provenance",
      "archive_list_branches",
      "archive_export",
      "archive_import",
      "archive_get_artifact",
      "diagnostics_capabilities",
      "diagnostics_protocol_catalog",
      "diagnostics_drift",
      "diagnostics_evidence",
      "diagnostics_storage_health",
      "diagnostics_recover",
      "analysis_profiles_run",
      "analysis_profiles_get",
      "analysis_compare",
      "analysis_excerpts",
      "analysis_experiments",
      "maintenance_backup",
      "maintenance_restore",
      "maintenance_lock",
      "maintenance_unlock",
      "maintenance_delete_conversation",
      "maintenance_delete_account",
      "maintenance_delete_archive",
    ];
    expect([...TOOL_NAMES].sort()).toEqual([...expected].sort());
  });

  it("has no generic exec/http/sql/shell escape hatches", () => {
    const haystack = TOOL_NAMES.join(" ");
    for (const banned of ["exec", "eval", "shell", "sql", "http", "fetch", "js"]) {
      expect(haystack).not.toMatch(new RegExp(`(^|_)${banned}(_|$)`));
    }
  });

  it("requires explicit account scope (never inferred)", () => {
    expect(() =>
      parseToolInput("archive_search", { query: "x" }),
    ).toThrow();
    expect(() =>
      parseToolInput("archive_search", {
        scope: { all: true },
        query: "x",
      }),
    ).not.toThrow();
  });

  it("gates destructive tools on directives", () => {
    for (const tool of DIRECTIVE_GATED_TOOLS) {
      const shape = (ToolSchemas[tool] as unknown as { shape: Record<string, unknown> }).shape;
      expect(shape, tool).toHaveProperty("directive_id");
    }
  });
});
