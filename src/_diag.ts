import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[diag] tab: ${rdp.tabUrl}`);
  // 1. sync set __OUT
  const set = yield* rdp.evalSync("window.__OUT='MARKER-123'; 'set-done'", 10);
  yield* Console.log("[1] sync set result:", JSON.stringify(set));
  // 2. sync read __OUT
  const read = yield* rdp.evalSync("typeof window.__OUT==='string'?window.__OUT:'NONE'", 10);
  yield* Console.log("[2] sync read __OUT:", JSON.stringify(read));
  // 3. sync fetch (no awaitPromise reliance) using XHR sync
  const xhr = yield* rdp.evalSync("(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/user',false);x.send();return x.status+' '+x.responseText.slice(0,200);}catch(e){return 'XHR-ERR:'+String(e);}})()", 15);
  yield* Console.log("[3] sync XHR /api/v4/user:", typeof xhr === "string" ? xhr.slice(0,400) : JSON.stringify(xhr));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
