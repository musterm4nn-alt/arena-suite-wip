/**
 * doctor — environment sanity for Arena Model Archive development.
 * Read-only. Exits non-zero with precise remediation on failure.
 */
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const pass = (name: string, detail = "ok") => checks.push({ name, ok: true, detail });
const fail = (name: string, detail: string) => checks.push({ name, ok: false, detail });

const root = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) pass("node", process.versions.node);
  else fail("node", `need >=20, have ${process.versions.node}`);

  // Platform
  pass("platform", `${os.platform()}/${os.arch()}`);
  if (os.platform() !== "darwin") {
    fail(
      "platform:macOS",
      `production shell needs darwin/arm64; P0 automated gate still runs here (${os.platform()}/${os.arch()})`,
    );
  } else if (os.arch() !== "arm64") {
    fail("platform:arm64", `need arm64, have ${os.arch()}`);
  } else {
    pass("platform:apple-silicon", String(os.release()));
  }

  // Electron pin present
  try {
    const pkg = JSON.parse(
      await readFile(path.join(root, "apps/desktop/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const pin = pkg.devDependencies?.["electron"];
    if (pin) pass("electron-pin", pin);
    else fail("electron-pin", "apps/desktop devDependencies.electron missing");
  } catch (err) {
    fail("electron-pin", String(err));
  }

  // TypeScript available
  try {
    execFileSync("npx", ["--no-install", "tsc", "--version"], { stdio: "pipe", cwd: root });
    pass("typescript", "resolves via npx");
  } catch {
    fail("typescript", "run npm install first");
  }

  // Vitest available
  try {
    execFileSync("npx", ["--no-install", "vitest", "--version"], { stdio: "pipe", cwd: root });
    pass("vitest", "resolves via npx");
  } catch {
    fail("vitest", "run npm install first");
  }

  // Writable scratch for partitions/staging (P0 harness)
  const scratch = path.join(os.tmpdir(), "arena-doctor-probe");
  try {
    const { mkdir, rm } = await import("node:fs/promises");
    await mkdir(scratch, { recursive: true });
    await access(scratch, constants.W_OK);
    await rm(scratch, { recursive: true, force: true });
    pass("scratch-writable", os.tmpdir());
  } catch (err) {
    fail("scratch-writable", String(err));
  }

  // Keychain tooling (macOS only; informational elsewhere)
  if (os.platform() === "darwin") {
    try {
      execFileSync("security", ["list-keychains"], { stdio: "pipe" });
      pass("keychain", "`security` CLI reachable");
    } catch {
      fail("keychain", "`security` CLI not reachable");
    }
  } else {
    pass("keychain", "skipped (non-macOS)");
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  — ${c.detail}`);
  }
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\ndoctor: ${failed.length} failing check(s). Non-macOS failures marked platform:* are expected off-target.`);
    // Only hard-fail for non-platform checks so Linux CI stays green.
    const hard = failed.filter((f) => !f.name.startsWith("platform:"));
    if (hard.length > 0) process.exit(1);
  }
}

await main();
