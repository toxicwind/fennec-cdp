# Fennec RDP Protocol — TDD Results

## Server → Client: Length-Prefixed Frames
Format: `<decimal_length>:<json_payload>`
- Server sends hello ONLY after client writes ANY byte
- The hello frame: `{"from":"root","applicationType":"browser",...}`
- Subsequent frames follow the same format

## Client → Server: Newline-Delimited JSON
Format: `{"to":"<actor>","type":"<command>",...}\n`
- Client uses **newline** delimiter (NOT length-prefix)
- This is the critical distinction I kept getting wrong

## Proven command flow
1. Connect → write `b"x"` → read hello (length-prefixed)
2. `{"to":"root","type":"listTabs"}\n` → drain notifications until `{"tabs":[...]}`
3. `{"to":"<tab.actor>","type":"attach"}\n` → returns frameUpdate
4. `{"to":"<tab.actor>","type":"getTarget"}\n` → returns `{"frame":{"consoleActor":"..."}}`
5. `{"to":"<consoleActor>","type":"evaluateJSAsync","text":"EXPR","awaitPromise":true}\n` → returns `{"type":"evaluationResult","result":VALUE}`

## Bash Redirect TDD — 18 tests (18/18 PASS)
All bash redirect semantics verified against `man bash`:
- `N>file` — redirect fd N to file ✓
- `N>>file` — append mode ✓
- `2>&1` — stderr → stdout merge ✓
- `1>&2` — stdout → stderr merge ✓
- `3>&1 1>&2` — fd swap via fd3 ✓
- `2>/dev/null` — discard stderr ✓
- `>file 2>&1` — both streams to file (correct order) ✓
- `2>&1 >file` — only stdout in file (wrong order) ✓
- `3>&2` — dup stderr to fd3 ✓
- `<file` — stdin from file ✓
- `> /dev/null` — discard stdout ✓
- `>>file 2>&1` — append both streams ✓
- `3>&2 2>&1 1>/dev/null` — multi-fd chain ✓
- `>` alone — syntax error ✓
- `>&` alone — syntax error ✓

## Python socket TDD — findings
- The bash probe (`printf 'x' | nc`) works 100% of the time
- Python's `socket.recv()` consistently times out or returns None
- **Hypothesis**: Python's `settimeout` or `recv` buffer handling differs from
  nc/bash's raw file descriptor I/O. The length-prefix reader may need a
  different framing approach (read delimiter `:` byte-by-byte instead of
  buffering).

## Keeper CDP — proven working
- CDP HTTP endpoint on `:25154`
- `GET /json/new` with PUT body → creates tab
- WebSocket at `webSocketDebuggerUrl` → CDP commands
- Cookie injection via `Network.setCookie` works (124 cookies)
- `Page.navigate` → navigates page
- `Runtime.evaluate` → executes JS, returns values
- Keeper has `curr-account` cookie matching our CF account but auth is expired
