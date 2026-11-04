import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[diag] tab: ${rdp.tabUrl}`);
  // set __OUT via sync XHR for zones
  const setJs = `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/zones?per_page=50',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|XHR-ERR:'+String(e);return 'ok';}})()`;
  const s = yield* rdp.evalSync(setJs, 20);
  yield* Console.log("[set] result:", JSON.stringify(s));
  yield* Effect.sleep("500 millis");
  // read __OUT type and length
  const g = yield* rdp.evalSync("(function(){var v=window.__OUT;return 'type='+typeof v+' len='+(typeof v==='string'?v.length:'n/a')+' head='+(typeof v==='string'?v.slice(0,80):JSON.stringify(v));})()", 15);
  yield* Console.log("[get] __OUT:", typeof g === "string" ? g : JSON.stringify(g));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
