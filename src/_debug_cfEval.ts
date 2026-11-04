import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
import { cfEval } from "./cf/api.ts";
import { CfZone } from "./cf/api.ts";
import { Schema } from "effect";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[dbg] tab: ${rdp.tabUrl}`);
  // Replicate cfEval steps manually with debug, for zones URL
  const url = "/api/v4/zones?per_page=50";
  const setJs = `(function(){try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url)},false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|XHR-ERR:'+String(e);return 'ok';}})()`;
  const getJs = `(function(){var v=window.__OUT;return typeof v==='string'?v:'NONE';})()`;
  const s = yield* rdp.evalSync(setJs, 20);
  yield* Console.log("[set] result:", JSON.stringify(s));
  yield* Effect.sleep("500 millis");
  const g = yield* rdp.evalSync(getJs, 20);
  yield* Console.log("[get] typeof:", typeof g, "isString:", typeof g === "string");
  if (typeof g === "string") yield* Console.log("[get] head:", g.slice(0, 60), "len:", g.length);
  else yield* Console.log("[get] obj:", JSON.stringify(g).slice(0,200));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
