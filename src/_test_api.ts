import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
import { whoami, listTokens, listZones } from "./cf/api.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[test] tab: ${rdp.tabUrl}`);
  const who = yield* whoami(rdp).pipe(Effect.match({ onFailure: e => ({err:String(e)}), onSuccess: v => v }));
  yield* Console.log("[whoami]", JSON.stringify(who).slice(0,500));
  const tokens = yield* listTokens(rdp).pipe(Effect.match({ onFailure: e => ({err:String(e)}), onSuccess: v => v }));
  yield* Console.log("[tokens]", JSON.stringify(tokens).slice(0,800));
  const zones = yield* listZones(rdp).pipe(Effect.match({ onFailure: e => ({err:String(e)}), onSuccess: v => v }));
  yield* Console.log("[zones]", JSON.stringify(zones).slice(0,800));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
