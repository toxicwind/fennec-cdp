import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Check the account owner / primary email
  const expr = `(async()=>{try{
    const out={};
    // Check account billing/owner info
    const a=await (await fetch('/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225',{credentials:'include'})).json();
    out.account=a;
    // Check the account's members (who's the owner)
    const m=await (await fetch('/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225/members',{credentials:'include'})).json();
    out.members=m;
    window.__OUT=JSON.stringify(out);
  }catch(e){window.__OUT='ERR:'+e.message;}return 'ok';})()`;
  yield* rdp.evalSync(expr);
  yield* Effect.sleep("3 seconds");
  const out = yield* rdp.evalSync(`typeof window.__OUT==='string'?window.__OUT:'none'`);
  yield* Console.log("[probe] owner:", String(out).slice(0, 2000));
  return out;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
