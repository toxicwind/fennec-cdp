import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Check account recovery / user verify endpoints
  const expr = `(async()=>{try{
    const out={};
    // Check if there's a way to verify ownership / recover the account
    const u=await (await fetch('/api/v4/user',{credentials:'include'})).json();
    out.user=u.result?{email:u.result.email,id:u.result.id,email_verified:u.result.email_verified}:u;
    // Check the account's owner info
    const a=await (await fetch('/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225',{credentials:'include'})).json();
    out.account=a.result?{name:a.result.name,id:a.result.id}:a;
    window.__OUT=JSON.stringify(out);
  }catch(e){window.__OUT='ERR:'+e.message;}return 'ok';})()`;
  yield* rdp.evalSync(expr);
  yield* Effect.sleep("3 seconds");
  const out = yield* rdp.evalSync(`typeof window.__OUT==='string'?window.__OUT:'none'`);
  yield* Console.log("[probe] recovery:", String(out).slice(0, 1500));
  return out;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
