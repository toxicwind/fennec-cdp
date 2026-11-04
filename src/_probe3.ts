import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[probe] tab: ${rdp.tabUrl}`);
  const r = yield* rdp.evalSync("JSON.stringify({href:location.href,title:document.title,body:(document.body?document.body.innerText:'').slice(0,500),cookies:document.cookie.slice(0,200)})", 15);
  yield* Console.log("[probe] page state:", r);
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
