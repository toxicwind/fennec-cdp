import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[probe] tab: ${rdp.tabUrl}`);
  const r = yield* rdp.evalSync("JSON.stringify({href:location.href,title:document.title,ready:document.readyState})", 15);
  yield* Console.log("[probe] evalSync:", JSON.stringify(r));
  const who = yield* rdp.evalAsyncGlobal("(await (await fetch('/api/v4/user')).json()).result", 30);
  yield* Console.log("[probe] whoami:", who);
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
