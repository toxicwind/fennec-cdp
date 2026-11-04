import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[probe] tab: ${rdp.tabUrl}`);
  // Timeout-bounded fetch in evalAsyncGlobal
  const js = "(async()=>{const T=(ms,fn)=>Promise.race([Promise.resolve().then(fn),new Promise((_,r)=>setTimeout(()=>r(new Error('tmo'+ms)),ms))]);" +
    "try{const r=await T(8000,()=>fetch('/api/v4/user'));const t=await T(8000,()=>r.text());window.__OUT='BODY:'+t.slice(0,300);}catch(e){window.__OUT='ERR:'+String(e);}return 'ok';})()";
  const r = yield* rdp.evalAsyncGlobal(js, 30);
  yield* Console.log("[probe] whoami async:", r);
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
