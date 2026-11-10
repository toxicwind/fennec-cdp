#!/usr/bin/env bun
/**
 * oneshot.ts — one-shot CLI actions over a fresh RDP connection.
 * Usage: bun oneshot.ts <tabs|cf-session|eval> <arg> <port>
 * Connects, acts, disconnects cleanly (frees the single-client slot).
 */
import { FennecRDP } from "./fennec-mcp.ts";

const [cmd, arg, portStr] = process.argv.slice(2);
const port = Number(portStr);
if (!Number.isFinite(port)) {
  console.error(JSON.stringify({ error: "bad port" }));
  process.exit(1);
}

const rdp = new FennecRDP(port);
try {
  const hello = await rdp.nextFrame(6000);
  if (!hello || hello.from !== "root") {
    console.log(JSON.stringify({ error: "no hello (wedged slot or fennec dead)" }));
    process.exit(1);
  }
  const tabs = await rdp.request({ to: "root", type: "listTabs" }, 8000);
  const list = (tabs?.tabs ?? []) as any[];

  if (cmd === "tabs") {
    console.log(JSON.stringify(list.map((t) => ({ actor: t.actor, url: t.url, title: t.title })), null, 1));
  } else if (cmd === "cf-session" || cmd === "eval") {
    const target = list.find((t) => (t.url ?? "").includes("cloudflare")) ?? list[0];
    if (!target) { console.log(JSON.stringify({ error: "no tabs" })); process.exit(1); }
    await rdp.request({ to: target.actor, type: "attach" }, 8000);
    const tgt = await rdp.request({ to: target.actor, type: "getTarget" }, 8000);
    const consoleActor = tgt?.frame?.consoleActor;
    if (!consoleActor) { console.log(JSON.stringify({ error: "no console actor" })); process.exit(1); }
    const expr = cmd === "cf-session"
      ? `(async()=>{ let me={}; try{ const r= await fetch('/client/v4/user'); me=await r.json(); }catch(e){ me={err:String(e)}; } return JSON.stringify({ email: me.result?.email ?? null, id: me.result?.id ?? null, cookies: document.cookie, href: location.href }); })()`
      : String(arg);
    // fire + wait for the RESOLVED value: the first evaluationResult carries
    // the Promise grip (state:pending); the resolved string arrives in a
    // later frame with the same resultID (awaitPromise + returnByValue).
    void rdp.request({ to: consoleActor, type: "evaluateJSAsync", text: expr, awaitPromise: true }, 1000).catch(() => null);
    for (let i = 0; i < 60; i++) {
      const f = await rdp.nextFrame(1500);
      if (f?.type !== "evaluationResult" || f.result == null) continue;
      const res = f.result as any;
      const isPendingPromise = res.type === "object" && res.class === "Promise"
        && res.preview?.ownProperties?.["<state>"]?.value === "pending";
      if (isPendingPromise) continue;
      console.log(JSON.stringify(res));
      process.exit(0);
    }
    console.log(JSON.stringify({ error: "promise never resolved" }));
    process.exit(1);
  }
} finally {
  rdp.close();
}
