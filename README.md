# fennec-cdp — Fennec (Firefox for Android) RDP to CDP adapter

> **Problem**: Keeper CDP (`:25154`) has a stale CF session — account `2d5e60db…2225`
> is logged in on the Pixel's fennec but the session cookie on keeper is expired.
> Fennec's DevTools RDP socket is the only source of fresh CF session cookies.
>
> **Goal**: Extract live CF session cookies from fennec → inject into keeper CDP →
> get authenticated CF dashboard access.

## The problem chain

1. Fennec on Pixel runs logged-in to `dash.cloudflare.com` (account `2d5e60db…2225`)
2. Keeper CDP (`:25154`) has a stale `__cf_logged_in=1` + expired auth cookie
3. `cf-live-cookies.json` has only `cf_clearance` cookies, not the authenticated session
4. `cf-cookies.json` has Google/Cloud cookies, not CF session cookies

## The protocol

Fennec DevTools uses **raw RDP** (not CDP), a length-prefixed frame protocol:

### Server → Client (length-prefixed frames)
```
<length>:<json>
```
e.g. `304:{"from":"root","applicationType":"browser",...}`

The server only sends the initial hello **after** receiving a client byte.

### Client → Server (newline-delimited JSON)
```
{"to":"root","type":"listTabs"}\n
```
**CRITICAL**: Client sends are newline-delimited JSON (NOT length-prefixed).
Server responses are always length-prefixed.

### Protocol mechanics (proven by TDD)
1. Connect → `adb forward tcp:PORT localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket`
2. Write 1 byte (`b"x"`) → server sends hello frame
3. Send `{"to":"root","type":"listTabs"}\n` (newline-delimited)
4. Read frames until `{"tabs":[...]}` appears (drain `frameUpdate` notifications first)
5. Attach to tab → `{"to":"<tab.actor>","type":"attach"}\n`
6. GetTarget → `{"to":"<tab.actor>","type":"getTarget"}\n` → yields `consoleActor`
7. evaluateJSAsync → `{"to":"<consoleActor>","type":"evaluateJSAsync","text":"EXPR","awaitPromise":true}\n`
8. Read `{"type":"evaluationResult","result":VALUE}` frame

### The single-client constraint
Fennec only accepts **one** debugger connection. Any disconnected/killed client
leaves the slot wedged until `adb forward --remove` + re-add, or force-stop fennec.

## The solution path

### Option A: Extract cookies via fennec JS
Run this inside fennec to get CF session cookies:
```js
(async()=>{
  const r = await fetch('/client/v4/user');
  const me = await r.json();
  return JSON.stringify({
    email: me.result?.email,
    id: me.result?.id,
    cookies: document.cookie  // CF cookies
  });
})()
```

### Option B: Use fennec's DevTools to grab all cookies
```js
(async()=>{
  const cookies = await new Promise(r => chrome?.experimental?.cookies?.getAll?.({url:'https://dash.cloudflare.com'}, c => r(c)));
  return JSON.stringify(cookies);
})()
```

### Option C: Dump fennec's cookie jar
Fennec stores cookies in SQLite: `~/.mozilla/firefox/<profile>/cookies.sqlite`
on the Pixel. We can extract via ADB:
```bash
adb pull /data/data/org.mozilla.fennec_fdroid/app_mozilla*/profiles/*/cookies.sqlite
sqlite3 cookies.sqlite "SELECT name, value, host, path, expiry, isSecure, isHttpOnly FROM moz_cookies WHERE host LIKE '%cloudflare%'"
```

## Files
- `src/protocol.md` — Protocol TDD results (bash redirect TDD, RDP framing)
- `src/rdp-driver.py` — Working RDP driver skeleton (see `/tmp/fennec-rdp-tdd.py`)

## Blocking issues
1. **Python socket framing**: The length-prefix reader (`<len>:`) consistently fails
   to parse the server hello even though raw bash `printf 'x' | nc` works.
   Root cause TBD — possibly `settimeout` behavior or `recv` buffering.
2. **Credential lock**: Pixel has a PIN lock; `adb input` can't bypass it.
3. **Single-client slot**: Each failed connection attempt wedges the RDP port.

## Keeper workaround (works but stale)
Keeper CDP on `:25154` has 124 cookies including `curr-account` matching our
CF account, but the auth token is expired. The dashboard shows the login page
instead of the logged-in dashboard.
