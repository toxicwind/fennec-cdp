import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[pg] tab: ${rdp.tabUrl}`);
  // GET permission groups, store in __OUT, read back (handle longString)
  const setJs = `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/permission_groups?per_page=200',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|XHR-ERR:'+String(e);return 'ok';}})()`;
  yield* rdp.evalSync(setJs, 25);
  yield* Effect.sleep("400 millis");
  const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 25);
  if (typeof g === "string") {
    yield* Console.log("[pg] str len", g.length, "head", g.slice(0, 100));
  } else if (g && typeof g === "object" && (g as any).type === "longString") {
    const full = yield* rdp.readLongString(g as any);
    yield* Console.log("[pg] longString len", full.length, "head", full.slice(0, 100));
    // parse and show a few permission groups
    try {
      const env = JSON.parse(full.slice(full.indexOf("|")+1));
      const groups = env.result || [];
      yield* Console.log("[pg] count", groups.length);
      yield* Console.log("[pg] sample:", JSON.stringify(groups.slice(0,5)));
    } catch(e) { yield* Console.log("[pg] parse err", String(e)); }
  } else {
    yield* Console.log("[pg] other", JSON.stringify(g));
  }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
