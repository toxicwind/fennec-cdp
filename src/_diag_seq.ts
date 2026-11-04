import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[diag] tab: ${rdp.tabUrl}`);
  // whoami first (as in sequence)
  let r = yield* rdp.evalSync("(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/user',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()", 15);
  yield* Console.log("[whoami set]", JSON.stringify(r));
  yield* Effect.sleep("400 millis");
  r = yield* rdp.evalSync("(function(){var v=window.__OUT;return typeof v==='string'?('len'+v.length+' head'+v.slice(0,30)):'nonstring';})()", 10);
  yield* Console.log("[whoami get]", typeof r === "string" ? r : JSON.stringify(r));
  // now zones
  r = yield* rdp.evalSync("(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/zones?per_page=50',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()", 20);
  yield* Console.log("[zones set]", JSON.stringify(r));
  yield* Effect.sleep("400 millis");
  r = yield* rdp.evalSync("(function(){var v=window.__OUT;return typeof v==='string'?('len'+v.length+' head'+v.slice(0,30)):'nonstring';})()", 10);
  yield* Console.log("[zones get]", typeof r === "string" ? r : JSON.stringify(r));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
