#!/usr/bin/env bun
/**
 * live.ts — hot-reloading live view of the Pixel's Fennec (Firefox) tab.
 *
 * Connects to the fennec RDP socket, polls the active tab (URL, title, body,
 * console), and streams it to a browser via SSE. Run under `bun --hot` so any
 * edit to this repo auto-reloads the daemon and the page keeps updating.
 *
 *   bun --hot src/live.ts [--port <http>] [--rdp <adb-forward-port>]
 *
 * Open http://127.0.0.1:<http>/ in a headed browser to watch the Pixel live.
 */
import { Effect, Console, Ref, Schedule } from "effect";
import { Command } from "commander";
import { Rdp } from "./rdp.ts";

const program = new Command();
program
  .option("-p, --port <n>", "HTTP port for the live view", parseInt)
  .option("-r, --rdp <n>", "adb forward port (omit to auto-forward)", parseInt)
  .parse(process.argv);

const opts = program.opts<{ port?: number; rdp?: number }>();
const HTTP_PORT = opts.port ?? 25260;

let rdp: Rdp | null = null;
let lastState: Record<string, unknown> = {};

const forwardPort = (): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    if (opts.rdp) return opts.rdp;
    const serial = process.env.ADB_SERIAL ?? "10.0.0.77:35093";
    yield* Effect.tryPromise({
      try: () =>
        Bun.$`adb -s ${serial} forward --remove localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`.quiet(),
      catch: () => new Error("remove failed"),
    }).pipe(Effect.ignore);
    const r = yield* Effect.tryPromise({
      try: () =>
        Bun.$`adb -s ${serial} forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`.quiet().text(),
      catch: (e) => new Error(`adb forward: ${String(e)}`),
    });
    const port = Number(r.trim().split(":").pop());
    if (Number.isNaN(port)) return yield* Effect.fail(new Error(`bad port: ${r}`));
    return port;
  });

/** Poll the tab state and stash it in `lastState` for the SSE feed. */
const pollState = (r: Rdp): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const raw = yield* r
      .evalAsyncGlobal(
        "(async()=>{try{const out={};out.href=location.href;out.title=document.title;" +
          "out.body=document.body?document.body.innerText.slice(0,4000):'';" +
          "out.ready=document.readyState;return out;" +
          "}catch(e){return {err:String(e),url:location.href};}})()",
        12,
      )
      .pipe(Effect.mapError((e) => new Error(String(e))));
    if (raw) {
      try {
        lastState = { ...JSON.parse(raw), ts: Date.now() };
      } catch {
        lastState = { raw, ts: Date.now() };
      }
    }
  });

const pollLoop = (r: Rdp): Effect.Effect<void, Error> =>
  pollState(r).pipe(
    Effect.match({
      onFailure: (e) => {
        void Console.log(`[live] poll error: ${e.message}`);
        return undefined;
      },
      onSuccess: () => undefined,
    }),
    Effect.repeat({ schedule: Schedule.spaced("1.5 seconds") }),
  );

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fennec · live</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#12161f; --panel2:#0f131b; --line:#1f2633;
    --txt:#d7e0ee; --dim:#7c889c; --acc:#ff6b9d; --acc2:#6ea8ff; --ok:#3ddc84;
    --err:#ff5c5c; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    background:radial-gradient(1200px 600px at 20% -10%, #1a2233 0%, var(--bg) 55%);
    color:var(--txt); font-family:var(--mono); min-height:100vh; padding:24px;
  }
  header { display:flex; align-items:baseline; gap:16px; margin-bottom:18px; }
  header h1 { font-size:20px; letter-spacing:.5px; }
  header h1 .dot { color:var(--acc); }
  header .sub { color:var(--dim); font-size:12px; }
  .pill { margin-left:auto; font-size:11px; padding:4px 10px; border-radius:999px;
    border:1px solid var(--line); color:var(--dim); background:var(--panel); }
  .pill.live { color:var(--ok); border-color:#1f4a33; background:#0d1f16; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid{grid-template-columns:1fr;} }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:16px; overflow:hidden; }
  .card h2 { font-size:11px; text-transform:uppercase; letter-spacing:1.5px;
    color:var(--dim); margin-bottom:12px; }
  .url { color:var(--acc2); word-break:break-all; font-size:13px; }
  .title { font-size:15px; margin-top:8px; }
  .meta { color:var(--dim); font-size:11px; margin-top:6px; display:flex; gap:14px; }
  pre.body { white-space:pre-wrap; word-break:break-word; font-size:12px;
    color:var(--txt); max-height:420px; overflow:auto; line-height:1.5; }
  .console { max-height:420px; overflow:auto; font-size:12px; }
  .console .line { padding:3px 0; border-bottom:1px solid #151b26; }
  .console .t { color:var(--dim); margin-right:8px; }
  .err { color:var(--err); }
  .bar { height:4px; border-radius:2px; background:#1a2333; margin-top:12px; overflow:hidden; }
  .bar i { display:block; height:100%; width:0%; background:linear-gradient(90deg,var(--acc),var(--acc2)); transition:width .4s; }
  .status { font-size:11px; color:var(--dim); margin-top:8px; }
</style>
</head>
<body>
<header>
  <h1><span class="dot">◆</span> fennec · live</h1>
  <span class="sub">Pixel → Firefox → this pane</span>
  <span class="pill" id="pill">connecting</span>
</header>
<div class="grid">
  <section class="card">
    <h2>Active tab</h2>
    <div class="url" id="url">—</div>
    <div class="title" id="title">—</div>
    <div class="meta"><span id="ready">—</span><span id="ts">—</span></div>
    <pre class="body" id="body">—</pre>
    <div class="bar"><i id="bar"></i></div>
  </section>
  <section class="card">
    <h2>Console</h2>
    <div class="console" id="console"><div class="line"><span class="t">…</span>waiting</div></div>
  </section>
</div>
<div class="status" id="status"></div>
<script>
  const $ = (id) => document.getElementById(id);
  const pill = $('pill'), url=$('url'), title=$('title'), body=$('body'),
        ready=$('ready'), ts=$('ts'), bar=$('bar'), status=$('status'), consoleEl=$('console');
  const es = new EventSource('/events');
  es.onopen = () => { pill.textContent='● live'; pill.classList.add('live'); };
  es.onerror = () => { pill.textContent='reconnecting'; pill.classList.remove('live'); };
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    url.textContent = d.href || '—';
    title.textContent = d.title || '—';
    body.textContent = d.body || (d.err ? '⚠ '+d.err : '—');
    ready.textContent = 'readyState: '+(d.ready||'—');
    ts.textContent = new Date(d.ts||Date.now()).toLocaleTimeString();
    bar.style.width = '100%';
    setTimeout(()=>{ bar.style.width='0%'; }, 400);
    if (d.err) status.textContent = 'last error: '+d.err;
    const line = document.createElement('div');
    line.className = 'line';
    line.innerHTML = '<span class="t">'+new Date().toLocaleTimeString()+'</span>'+
      (d.href||'—');
    consoleEl.prepend(line);
    while (consoleEl.children.length > 80) consoleEl.lastChild.remove();
  };
</script>
</body>
</html>`;

const server = Bun.serve({
  port: HTTP_PORT,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          const timer = setInterval(() => {
            controller.enqueue(`data: ${JSON.stringify(lastState)}\n\n`);
          }, 1500);
          req.signal.addEventListener("abort", () => clearInterval(timer));
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    if (u.pathname === "/state") return Response.json(lastState);
    return new Response("not found", { status: 404 });
  },
});

const main = Effect.gen(function* () {
  yield* Console.log(`[live] HTTP on :${HTTP_PORT} — open http://127.0.0.1:${HTTP_PORT}/`);
  const port = yield* forwardPort();
  yield* Console.log(`[live] forwarding to fennec RDP :${port}`);
  const conn = yield* Rdp.connect(port).pipe(
    Effect.match({
      onFailure: (e) => {
        void Console.log(`[live] connect failed: ${e.message} — retrying`);
        return null as unknown as Rdp;
      },
      onSuccess: (r) => r,
    }),
  );
  if (conn) {
    rdp = conn;
    yield* Console.log(`[live] connected, tab: ${rdp.tabUrl}`);
    const loop = pollLoop(rdp).pipe(
      Effect.match({
        onFailure: (e) => {
          void Console.log(`[live] ${e.message}`);
          return undefined;
        },
        onSuccess: () => undefined,
      }),
    );
    yield* Effect.forkChild(loop);
  }
  yield* Effect.never;
});

Effect.runPromise(main).catch((e) => {
  console.error("[live] FATAL:", e);
  process.exit(1);
});