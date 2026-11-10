import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

// Use raw CDP via the Rdp socket to send Network.clearBrowserCookies
const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Send Network.clearBrowserCookies via the raw socket
  // rdp.send is private, so use a direct socket approach
  yield* Console.log("[probe] connected, sending clearBrowserCookies");
  // The Rdp class has send but it's private. Let me use the consoleActor.
  // Actually, use the Runtime to clear via the DevTools protocol.
  // For HttpOnly cookies, we need Network.clearBrowserCookies which requires
  // the raw CDP session. Let me use evaluateJSAsync with a different approach.
  // 
  // The simplest: navigate to a URL that triggers a fresh session, or use
  // the CDP Network domain. But rdp.ts doesn't expose Network.
  // 
  // Alternative: use the phone's Firefox to log out via the UI.
  yield* Console.log("[probe] need Network.clearBrowserCookies - use CDP directly");
  return "need-cdp-network";
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
