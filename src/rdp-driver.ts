// Bun RDP driver for Fennec's firefox-debugger-socket.
// Protocol (proven by fennec-cdp TDD, see src/protocol.md):
//   - client → server: newline-delimited JSON
//   - server → client: length-prefixed frames `<len>:<json>`
//   - server sends hello only after receiving one client byte
// The python driver failed on framing; Bun's buffered reads make this trivial.
//
// Usage: bun src/rdp-driver.ts <localPort> '<js-expression>'
//   Evaluates the expression in the first tab whose url matches --url-match
//   (default: cloudflare). Prints the evaluationResult JSON to stdout.

import net from "node:net";

const args = process.argv.slice(2);
const port = Number(args[0] ?? 6000);
const urlMatch = args[1] ?? "cloudflare";
const jsExpr = args[2];

if (!jsExpr) {
  console.error("usage: bun src/rdp-driver.ts <port> <urlMatch> <jsExpr>");
  process.exit(2);
}

const dbg = process.env.RDP_DEBUG === "1";
let buf = "";
const pending: Array<() => void> = [];

const onChunk = (chunk: Buffer): void => {
  buf += chunk.toString("utf8");
  const ps = pending.splice(0);
  for (const p of ps) p();
};

const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
  // connected — wake the server with one byte (hello follows)
  socket.write("x");
});
socket.on("data", onChunk);
socket.on("error", (err) => {
  console.error(JSON.stringify({ error: "socket", message: String(err) }));
  process.exit(1);
});

function tryFrames(): string[] {
  const frames: string[] = [];
  for (;;) {
    const idx = buf.indexOf(":");
    if (idx === -1) break;
    const len = Number(buf.slice(0, idx));
    if (!Number.isFinite(len) || buf.length < idx + 1 + len) break;
    frames.push(buf.slice(idx + 1, idx + 1 + len));
    buf = buf.slice(idx + 1 + len);
  }
  return frames;
}

const waitFor = (pred: (f: any) => boolean, timeoutMs = 15000): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RDP wait timeout")), timeoutMs);
    const check = (): void => {
      for (const raw of tryFrames()) {
        let f: any;
        try {
          f = JSON.parse(raw);
        } catch {
          continue;
        }
        if (dbg) console.error(`frame: ${raw.slice(0, 200)}`);
        if (pred(f)) {
          clearTimeout(timer);
          resolve(f);
          return;
        }
      }
      pending.push(check);
    };
    check();
  });

const send = (obj: object): void => {
  socket.write(JSON.stringify(obj) + "\n");
};

// 1. wake the server with one byte → hello frame (done in connect callback)

if (dbg) console.error("waiting for hello");
await waitFor((f) => f.from === "root" && f.applicationType, 10000);
if (dbg) console.error("hello ok");

// 2. listTabs → find target tab
send({ to: "root", type: "listTabs" });
const tabsRes = await waitFor((f) => Array.isArray(f.tabs), 10000);
if (dbg) console.error(`tabs: ${tabsRes.tabs.length}`);
const tab = tabsRes.tabs.find(
  (t: any) => typeof t.url === "string" && t.url.includes(urlMatch),
);
if (!tab) {
  console.error(JSON.stringify({ error: "no matching tab", tabs: tabsRes.tabs.map((t: any) => t.url) }));
  process.exit(1);
}

// 3. attach → getTarget → consoleActor
send({ to: tab.actor, type: "attach" });
await waitFor((f) => f.type === "attached" || f.from === tab.actor, 10000);
send({ to: tab.actor, type: "getTarget" });
const targetRes = await waitFor((f) => f.type === "target-attached-form" || f.consoleActor || f.type === "worked", 10000);
const consoleActor = targetRes.consoleActor ?? targetRes.target?.consoleActor;
if (!consoleActor) {
  console.error(JSON.stringify({ error: "no consoleActor", targetRes }));
  process.exit(1);
}

// 4. evaluateJSAsync
send({ to: consoleActor, type: "evaluateJSAsync", text: jsExpr, awaitPromise: true, eager: false });
const evalRes = await waitFor((f) => f.type === "evaluationResult" || f.type === "error", 30000);
console.log(JSON.stringify(evalRes, null, 2));
socket.end();
process.exit(0);
