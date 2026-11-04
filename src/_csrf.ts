import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[csrf] tab: ${rdp.tabUrl}`);
  // Look for CSRF token: meta tags, window globals, cookies
  const js = `(function(){var out={};out.metas=[];document.querySelectorAll('meta').forEach(function(m){if(/csrf|token|nonce/i.test(m.name||'')||/csrf|token/i.test(m.httpEquiv||''))out.metas.push({name:m.name,content:m.content});});out.globals=Object.keys(window).filter(function(k){return /csrf|token|nonce/i.test(k);}).slice(0,20);out.cookies=document.cookie;return JSON.stringify(out);})()`;
  const r = yield* rdp.evalSync(js, 15);
  yield* Console.log("[csrf]", typeof r === "string" ? r : JSON.stringify(r));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
