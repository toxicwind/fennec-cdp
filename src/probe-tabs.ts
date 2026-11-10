import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* Console.log("[probe] connected, handshaking...");
  const result = yield* rdp.handshake();
  yield* Console.log("[probe] handshake done, tab:", JSON.stringify(result));
  return result;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", JSON.stringify(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
