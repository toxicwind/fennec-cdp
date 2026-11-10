import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Navigate to the forgot-password page directly (it handles logged-in state)
  const nav = yield* rdp.navigate("https://dash.cloudflare.com/forgot-password", "forgot-password", 8000);
  yield* Console.log("[probe] nav result:", String(nav));
  // Check the page state
  const state = yield* rdp.evalSync(`JSON.stringify({href: location.href, title: document.title, body: document.body?document.body.innerText.slice(0,600):''})`);
  yield* Console.log("[probe] page:", String(state));
  return state;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
