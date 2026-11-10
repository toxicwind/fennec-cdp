import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* Console.log("[probe] handshaking...");
  yield* rdp.handshake();
  yield* Console.log("[probe] handshake ok, evaluating whoami...");
  // Evaluate the CF user via page-context fetch
  const whoami = yield* rdp.evalAsyncGlobal(`(await (await fetch('/api/v4/user')).json()).result`);
  yield* Console.log("[probe] whoami:", JSON.stringify(whoami));
  return whoami;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", JSON.stringify(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
