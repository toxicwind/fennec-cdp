import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";

const prog = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(9225);
  yield* rdp.handshake();
  // Log out by clearing CF auth cookies and navigating to a fresh login
  const expr = `(async()=>{
    // Clear all CF auth cookies
    const cookies = document.cookie.split(';');
    for (const c of cookies) {
      const name = c.split('=')[0].trim();
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.cloudflare.com';
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.dash.cloudflare.com';
    }
    // Also try the CF logout API
    try { await fetch('/api/v4/logout', {method:'POST', credentials:'include'}); } catch(e) {}
    window.__OUT='LOGGED_OUT';
    return 'ok';
  })()`;
  yield* rdp.evalSync(expr);
  yield* Effect.sleep("2 seconds");
  // Navigate to the login page fresh
  const nav = yield* rdp.navigate("https://dash.cloudflare.com/login", "login", 8000);
  yield* Console.log("[probe] nav to login:", String(nav));
  const state = yield* rdp.evalSync(`JSON.stringify({href: location.href, title: document.title, body: document.body?document.body.innerText.slice(0,400):''})`);
  yield* Console.log("[probe] login page:", String(state));
  return state;
});

Effect.runPromise(prog).then((r) => {
  console.log("SUCCESS:", String(r));
  process.exit(0);
}).catch((e) => {
  console.log("ERROR:", e?.message || e);
  process.exit(1);
});
