#!/usr/bin/env bun
/**
 * fennec-mcp — persistent Fennec RDP → MCP bridge (Bun/TS, no python).
 *
 * WHY: fennec's DevTools RDP server accepts exactly ONE client. Every
 * connect→exit cycle wedges the slot for the next run (the ghost-client
 * wedge). This server holds ONE persistent RDP connection for its lifetime
 * and exposes it as MCP tools — the single-client constraint becomes the
 * design.
 *
 * Protocol (Firefox 159, verified live 2026-11-04):
 *   server → client: length-prefixed frames  <len>:<json>
 *   client → server: length-prefixed frames  <len>:<json>  (newline barebone
 *                    transport is DROPPED in 159 — v1's listTabs silence)
 *   hello arrives UNPROMPTED on connect (the 'x' nudge is gone in 159 and
 *   desyncs transport detection).
 *
 * Tools:
 *   fennec_tabs       — list open tabs (actor + url + title)
 *   fennec_eval       — evaluate JS in a tab's console actor (async awaited)
 *   fennec_cf_session — extract the live CF session (email/id/cookies) from
 *                       the dash.cloudflare.com tab
 *
 * Run: bun src/fennec-mcp.ts   (stdio MCP)
 */
import * as net from "node:net";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type Frame = Record<string, any>;

export class FennecRDP {
  sock: net.Socket;
  private acc: Buffer = Buffer.alloc(0);
  /** frames nobody has claimed yet (hello, events, async results) */
  private unclaimed: Frame[] = [];
  private waiters: { resolve: (f: Frame) => void; timer: NodeJS.Timeout }[] = [];

  constructor(public port: number) {
    this.sock = net.connect({ port, host: "127.0.0.1" });
    this.sock.setNoDelay(true);
    this.sock.on("data", (chunk: Buffer) => {
      this.acc = Buffer.concat([this.acc, chunk]);
      for (;;) {
        const colon = this.acc.indexOf(58); // ":"
        if (colon < 0) break;
        const n = Number(this.acc.subarray(0, colon).toString("ascii"));
        if (!Number.isFinite(n) || this.acc.length < colon + 1 + n) break;
        const body = this.acc.subarray(colon + 1, colon + 1 + n).toString("utf8");
        this.acc = this.acc.subarray(colon + 1 + n);
        this.onFrame(body);
      }
    });
    this.sock.on("error", () => { /* requests surface via timeout */ });
  }

  private onFrame(body: string): void {
    let f: Frame;
    try { f = JSON.parse(body); } catch { return; }
    const w = this.waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(f); return; }
    this.unclaimed.push(f);
  }

  /** Next frame (claimed or unclaimed-buffered), or null on timeout. */
  nextFrame(timeoutMs: number): Promise<Frame | null> {
    const buffered = this.unclaimed.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const wrapped = (f: Frame) => { clearTimeout(timer); resolve(f); };
      this.waiters.push({ resolve: wrapped, timer });
    });
  }

  /** Send a length-prefixed request; returns the next frame (or null). */
  async request(msg: Frame, timeoutMs = 8000): Promise<Frame | null> {
    const payload = Buffer.from(JSON.stringify(msg), "utf8");
    this.sock.write(Buffer.concat([
      Buffer.from(`${payload.length}:`, "ascii"),
      payload,
    ]));
    return this.nextFrame(timeoutMs);
  }

  close(): void { this.sock.destroy(); }
}

// ── session state ───────────────────────────────────────────────────────────

let rdp: FennecRDP | null = null;
let consoleActor: string | null = null;
let cfTab: Frame | null = null;

const SERIAL = process.env.ADB_SERIAL
  ?? "adb-4C121FDAS0004Y-iQyNOl._adb-tls-connect._tcp";

async function sh(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
  });
}

/** Fresh forward + connect. Does NOT touch the device UI. */
async function connect(): Promise<boolean> {
  const out = await sh(
    `adb -s ${SERIAL} forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`,
  );
  const port = Number(out.trim().split("\n").filter(Boolean).pop());
  if (!Number.isFinite(port) || port <= 0) return false;
  rdp = new FennecRDP(port);
  const hello = await rdp.nextFrame(6000); // hello arrives unprompted (159)
  return hello != null && hello.from === "root";
}

async function ensureSession(): Promise<boolean> {
  if (rdp && consoleActor) return true;
  if (!rdp && !(await connect())) return false;
  const tabs = await rdp!.request({ to: "root", type: "listTabs" }, 8000);
  if (!tabs?.tabs?.length) return false;
  cfTab = tabs.tabs.find((t: Frame) => (t.url ?? "").includes("cloudflare")) ?? tabs.tabs[0];
  const attach = await rdp!.request({ to: cfTab.actor, type: "attach" }, 8000);
  if (!attach?.frame?.consoleActor) return false;
  consoleActor = attach.frame.consoleActor;
  return true;
}

async function evalInTab(expression: string): Promise<unknown> {
  if (!rdp || !consoleActor) return { error: "no session" };
  // Fire the async eval; the promise resolves in a LATER evaluationResult
  // frame (the first carries result: null).
  void rdp.request(
    { to: consoleActor, type: "evaluateJSAsync", text: expression, awaitPromise: true },
    1000,
  ).catch(() => null);
  for (let i = 0; i < 40; i++) {
    const f = await rdp.nextFrame(1500);
    if (f?.type === "evaluationResult" && f.result != null) return f.result;
  }
  return { error: "no evaluationResult with value" };
}

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "fennec-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

export async function listTools(): Promise<unknown> {
  return { tools: TOOLS };
}

const TOOLS: any[] = [
    {
      name: "fennec_tabs",
      description:
        "List open fennec tabs (actor, url, title). Persistent RDP connection — no UI interruption, no slot wedging.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "fennec_eval",
      description:
        "Evaluate JS in a tab's console actor (async promises awaited). Default tab: the dash.cloudflare.com tab.",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "JS expression to evaluate" },
          tab_url_substring: { type: "string", description: "optional tab filter" },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
    {
      name: "fennec_cf_session",
      description:
        "Extract the live Cloudflare session from the logged-in dashboard tab: email, user id, document.cookie. The CF-recovery primitive.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
];

server.setRequestHandler(ListToolsRequestSchema, listTools);

export async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  try {
    if (!(await ensureSession())) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "no RDP session (fennec dead or socket wedged)" }) }] };
    }
    if (name === "fennec_tabs") {
      const tabs = await rdp!.request({ to: "root", type: "listTabs" }, 8000);
      return { content: [{ type: "text", text: JSON.stringify((tabs?.tabs ?? []).map((t: Frame) => ({ actor: t.actor, url: t.url, title: t.title })), null, 1) }] };
    }
    if (name === "fennec_eval") {
      const sub = args.tab_url_substring;
      if (sub && !(cfTab?.url ?? "").includes(sub)) {
        const tabs = await rdp!.request({ to: "root", type: "listTabs" }, 8000);
        const t = (tabs?.tabs ?? []).find((x: Frame) => (x.url ?? "").includes(sub));
        if (!t) return { content: [{ type: "text", text: JSON.stringify({ error: `no tab matching ${sub}` }) }] };
        cfTab = t;
        const a = await rdp!.request({ to: t.actor, type: "attach" }, 8000);
        consoleActor = a?.frame?.consoleActor ?? consoleActor;
      }
      const result = await evalInTab(String(args.expression));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (name === "fennec_cf_session") {
      const expr = `(async()=>{ let me={}; try{ const r= await fetch('/client/v4/user'); me=await r.json(); }catch(e){ me={err:String(e)}; } return JSON.stringify({ email: me.result?.email ?? null, id: me.result?.id ?? null, cookies: document.cookie, href: location.href }); })()`;
      const result = await evalInTab(expr);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: `unknown tool ${name}` }) }] };
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: String(e) }) }] };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, any>));

// stdio server starts only when run as main — importing for tests must not
// grab fd 0/1 (the bun-stdio-fd0-pump trap).
if (import.meta.main) {
  const transport = new StdioServerTransport();
  void server.connect(transport);
  console.error("fennec-mcp: stdio up (persistent RDP bridge)");
}
