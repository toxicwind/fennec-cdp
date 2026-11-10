import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Try the legacy pagerules for waverss.com (zone 420ae1bb292aaaaa61c1281eaf7df9a0)
  const kick = `(async()=>{try{const r=await fetch('/api/v4/zones/420ae1bb292aaaaa61c1281eaf7df9a0/pagerules',{credentials:'include'});const t=await r.text();window.__OUT='RES:'+r.status+':'+t.slice(0,1500);}catch(e){window.__OUT='ERR:'+e.message;}return 'ok';})()`;
  yield* rdp.evalSync(kick);
  yield* Effect.sleep("3 seconds");
  const out = yield* rdp.evalSync(`typeof window.__OUT==='string'?window.__OUT:'none'`);
  yield* Console.log("[probe] pagerules:", String(out));
  return out;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
