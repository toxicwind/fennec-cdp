import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  yield* Console.log("[probe] handshake ok");
  // Sync eval: set a global that the async will fill, then check it
  // First, kick off an async fetch that writes to window.__OUT
  const kick = `(async()=>{try{const r=await fetch('/api/v4/user',{credentials:'include'});const t=await r.text();window.__OUT='RES:'+r.status+':'+t.slice(0,500);}catch(e){window.__OUT='ERR:'+e.message;}return 'ok';})()`;
  yield* rdp.evalSync(kick);
  yield* Console.log("[probe] kicked async fetch");
  // Wait a moment then read __OUT
  yield* Effect.sleep("3 seconds");
  const out = yield* rdp.evalSync(`typeof window.__OUT==='string'?window.__OUT:'none'`);
  yield* Console.log("[probe] __OUT:", String(out));
  return out;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
