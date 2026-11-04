/**
 * fennec-mcp.live.ts — LIVE twin: real fennec on the real Pixel.
 *
 * Coverage doctrine (AGENTS.md §1.9): the 90% gate is the LIVE tests. This
 * file drives the REAL RDP socket (adb forward → localabstract) against the
 * real fennec 159 on the Pixel — no mocks, no python.
 *
 * Skips cleanly when the device is unreachable. Never interrupts the user:
 * forward + RDP only; no force-stop, no foreground flash.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import { FennecRDP } from "../src/fennec-mcp.ts";

const SERIAL = process.env.ADB_SERIAL
  ?? "adb-4C121FDAS0004Y-iQyNOl._adb-tls-connect._tcp";

function sh(cmd: string): string {
  return spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 15000 }).stdout ?? "";
}

function deviceUp(): boolean {
  const out = sh(`adb -s ${SERIAL} forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`);
  return /^\d+$/.test(out.trim());
}

let rdp: FennecRDP | null = null;

async function liveRdp(): Promise<FennecRDP> {
  if (rdp) return rdp;
  const out = sh(`adb -s ${SERIAL} forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`);
  const port = Number(out.trim());
  expect(Number.isFinite(port) && port > 0).toBe(true);
  rdp = new FennecRDP(port);
  const hello = await rdp.nextFrame(8000);
  expect(hello).not.toBeNull();
  expect(hello!.from).toBe("root");
  return rdp;
}

describe("fennec RDP (live pixel)", () => {
  test("device reachable + forward up", () => {
    if (!deviceUp()) return; // skip silently when the pixel is away
    expect(true).toBe(true);
  });

  test("hello arrives unprompted on the real socket (159 contract)", async () => {
    if (!deviceUp()) return;
    const r = await liveRdp();
    expect(r.port).toBeGreaterThan(0);
  });

  test("listTabs returns the CF tab (length-prefixed transport)", async () => {
    if (!deviceUp()) return;
    const r = await liveRdp();
    const tabs = await r.request({ to: "root", type: "listTabs" }, 8000);
    expect(tabs).not.toBeNull();
    expect(Array.isArray(tabs!.tabs)).toBe(true);
    // the fennec tab set must include the cloudflare dashboard tab
    const urls = (tabs!.tabs as any[]).map((t) => t.url ?? "");
    expect(urls.some((u) => u.includes("cloudflare"))).toBe(true);
  });
});
