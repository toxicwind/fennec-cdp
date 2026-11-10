import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const p = Effect.gen(function* () {
  const r = yield* Rdp.connect(9225);
  yield* r.handshake();
  yield* r.navigate("https://mail.google.com", "mail.google.com", 8000);
  yield* Effect.sleep("3 seconds");
  const st = yield* r.evalSync(`JSON.stringify({href:location.href,title:document.title,body:document.body?document.body.innerText.slice(0,600):''})`);
  yield* Console.log("GMAIL:", String(st));
  return st;
});
Effect.runPromise(p).then(r=>{console.log("OK:",String(r));process.exit(0)}).catch(e=>{console.log("ERR:",e?.message||e);process.exit(1)});
