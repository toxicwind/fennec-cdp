import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[probe] tab: ${rdp.tabUrl}`);
  // evalAsyncGlobal sets window.__OUT and polls. Test each API call.
  const calls: Array<[string, string]> = [
    ["user", "(await (await fetch('/api/v4/user')).json()).result"],
    ["accounts", "(await (await fetch('/api/v4/accounts')).json()).result"],
    ["tokens", "(await (await fetch('/api/v4/user/tokens')).json()).result"],
  ];
  for (const [name, expr] of calls) {
    const r = yield* rdp.evalAsyncGlobal(expr, 25);
    yield* Console.log(`[${name}]`, typeof r === "string" ? r.slice(0, 900) : JSON.stringify(r));
  }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
