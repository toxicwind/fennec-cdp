import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Check the user's memberships and any pending invites
  const expr = `(async()=>{try{
    const m=await (await fetch('/api/v4/memberships',{credentials:'include'})).json();
    const i=await (await fetch('/api/v4/invitations',{credentials:'include'})).json();
    window.__OUT=JSON.stringify({memberships:m, invitations:i});
  }catch(e){window.__OUT='ERR:'+e.message;}return 'ok';})()`;
  yield* rdp.evalSync(expr);
  yield* Effect.sleep("3 seconds");
  const out = yield* rdp.evalSync(`typeof window.__OUT==='string'?window.__OUT:'none'`);
  yield* Console.log("[probe] memberships+invites:", String(out).slice(0, 2000));
  return out;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
