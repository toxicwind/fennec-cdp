import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
// Use the sync eval path (works reliably) to call CF API endpoints.
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[probe] tab: ${rdp.tabUrl}`);
  const calls: Array<[string, string]> = [
    ["user", "fetch('/api/v4/user').then(r=>r.text())"],
    ["accounts", "fetch('/api/v4/accounts').then(r=>r.text())"],
    ["tokens", "fetch('/api/v4/user/tokens').then(r=>r.text())"],
  ];
  for (const [name, expr] of calls) {
    const r = yield* rdp.evalSync(`(async()=>{try{return await ${expr};}catch(e){return 'ERR:'+String(e);}})()`, 20);
    yield* Console.log(`[${name}]`, typeof r === "string" ? r.slice(0, 800) : JSON.stringify(r));
  }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
