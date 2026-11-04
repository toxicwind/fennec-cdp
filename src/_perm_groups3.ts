import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[pg] tab: ${rdp.tabUrl}`);
  const setJs = `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/user/tokens/permission_groups?per_page=500',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()`;
  yield* rdp.evalSync(setJs, 25);
  yield* Effect.sleep("400 millis");
  const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 25);
  let text = "";
  if (typeof g === "string") text = g;
  else if (g && typeof g === "object" && (g as any).type === "longString") text = yield* rdp.readLongString(g as any);
  const pipe = text.indexOf("|");
  const body = pipe > 0 ? text.slice(pipe+1) : text;
  try {
    const env = JSON.parse(body);
    const groups = env.result || [];
    const wanted = ["Zone Read","Zone Write","Zone Settings Write","Page Rules","Page Rules Write","Rulesets Write","Rulesets Read","Account Settings Read","Account Settings Write","Zone:Read","Zone:Write"];
    for (const w of wanted) {
      const m = groups.filter((x:any) => (x.name||"").toLowerCase().includes(w.toLowerCase()) || (x.label||"").toLowerCase().includes(w.toLowerCase()));
      if (m.length) yield* Console.log(`[${w}]`, JSON.stringify(m.map((x:any)=>({id:x.id,name:x.name,label:x.label}))));
    }
  } catch(e) { yield* Console.log("[pg] parse err", String(e)); }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
