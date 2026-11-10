import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  yield* Console.log("[probe] handshake ok");
  // Check page state synchronously
  const state = yield* rdp.evalSync(`JSON.stringify({href: location.href, title: document.title, ready: document.readyState})`);
  yield* Console.log("[probe] page state:", String(state));
  return state;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
