import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // List all tabs to find a gmail one
  // The handshake picks the CF tab. Let me check the current tab and try to find gmail.
  const state = yield* rdp.evalSync(`JSON.stringify({href: location.href, title: document.title})`);
  yield* Console.log("[probe] current tab:", String(state));
  // Check if we can navigate to gmail
  const nav = yield* rdp.navigate("https://mail.google.com", "mail.google.com", 8000);
  yield* Console.log("[probe] nav to gmail:", String(nav));
  const gmail = yield* rdp.evalSync(`JSON.stringify({href: location.href, title: document.title, body: document.body?document.body.innerText.slice(0,300):''})`);
  yield* Console.log("[probe] gmail state:", String(gmail));
  return gmail;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
