#!/usr/bin/env bun
/**
 * replay.ts — replay the exact URL the attacker used to reach the account
 * api-tokens page, headless, exit, full error output as hooked try/catch.
 *
 * Usage:
 *   bun src/replay.ts [--port <adb-forward-port>] [--url <cf-url>]
 *
 * If --port is omitted, runs `adb forward` fresh (restarting fennec first via
 * bin/fennec-forward.sh is recommended to clear the single-client slot).
 */
import { Effect, Console } from "effect";
import { Command } from "commander";
import { Rdp } from "./rdp.ts";
import { whoami, listTokens } from "./cf/api.ts";

const program = new Command();
program
  .option("-p, --port <n>", "adb forward port (omit to auto-forward)", parseInt)
  .option(
    "-u, --url <url>",
    "target CF URL to replay",
    "https://dash.cloudflare.com/2d5e60dbc717af626a1eb04177aa2225/api-tokens",
  )
  .parse(process.argv);

const opts = program.opts<{ port?: number; url: string }>();

const forwardPort = (): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    if (opts.port) return opts.port;
    const serial = process.env.ADB_SERIAL ?? "10.0.0.77:35093";
    yield* Effect.tryPromise({
      try: () =>
        Bun.$`adb -s ${serial} forward --remove localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`.quiet(),
      catch: () => new Error("adb forward --remove failed (non-fatal)"),
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

const main = Effect.gen(function* () {
  const port = yield* forwardPort();
  yield* Console.log(`[fennec] connecting :${port}`);
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[fennec] tab: ${rdp.tabUrl}`);

  const final = yield* rdp.navigate(opts.url, "api-tokens", 6000);
  yield* Console.log(`[replay] final href: ${final}`);

  // After landing, dump the full page state via a hooked try/catch eval.
  // Every awaited step is wrapped in a `T(ms, fn)` timeout race so no single
  // line can hang the whole replay — a stuck fetch/navigation fails fast.
  const state = yield* rdp.evalAsyncGlobal(
    "(async()=>{const T=(ms,fn)=>Promise.race([Promise.resolve().then(fn),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout '+ms)),ms))]);" +
      "try{const out={};" +
      "out.href=await T(5000,()=>location.href);" +
      "out.title=await T(5000,()=>document.title);" +
      "out.body=await T(5000,()=>document.body?document.body.innerText.slice(0,800):'');" +
      "const me=await T(8000,()=>F('/api/v4/user'));out.user={email:me.result&&me.result.email,id:me.result&&me.result.id,orgs:(me.result&&me.result.organizations||[]).length};" +
      "return out;}catch(e){return {err:String(e),url:location.href};}})()",
    40,
  );
  yield* Console.log(`[replay] state: ${state}`);

  // If we have owner access, enumerate tokens.
  const who = yield* whoami(rdp).pipe(
    Effect.match({
      onFailure: (e) => ({ err: String(e) }),
      onSuccess: (v) => v,
    }),
  );
  yield* Console.log(`[whoami] ${JSON.stringify(who)}`);
  if ("email" in who) {
    const tokens = yield* listTokens(rdp).pipe(
      Effect.match({
        onFailure: (e) => ({ err: String(e) }),
        onSuccess: (v) => v,
      }),
    );
    yield* Console.log(`[tokens] ${JSON.stringify(tokens)}`);
  }

  rdp.close();
  yield* Console.log("[replay] done");
});

Effect.runPromise(main).catch((e) => {
  console.error("[replay] FATAL:", e);
  process.exit(1);
});