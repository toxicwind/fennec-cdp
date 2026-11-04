import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[mem] tab: ${rdp.tabUrl}`);
  const js = `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/memberships',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()`;
  yield* rdp.evalSync(js, 20);
  yield* Effect.sleep("300 millis");
  const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 20);
  let text = "";
  if (typeof g === "string") text = g;
  else if (g && typeof g === "object" && (g as any).type === "longString") text = yield* rdp.readLongString(g as any);
  const pipe = text.indexOf("|");
  const body = pipe > 0 ? text.slice(pipe+1) : text;
  yield* Console.log("[mem] full:", body.slice(0, 1500));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
