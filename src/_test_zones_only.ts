import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
import { listZones } from "./cf/api.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[test] tab: ${rdp.tabUrl}`);
  const zones = yield* listZones(rdp).pipe(Effect.match({ onFailure: e => ({err:String(e)}), onSuccess: v => v }));
  yield* Console.log("[zones]", JSON.stringify(zones).slice(0,600));
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
