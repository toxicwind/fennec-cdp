#!/usr/bin/env python3
"""
fennec-cdp — Fennec (Firefox for Android) RDP protocol driver.

Protocol: Server→Client uses length-prefixed frames (<len>:<json>).
          Client→Server uses newline-delimited JSON.

Usage: python3 rdp-driver.py <fennec-port>

The fennec port comes from:
  adb forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket
"""
import socket, json, sys, time, subprocess

class FennecRDP:
    """Fennec DevTools RDP client.

    Server frames are length-prefixed: <N>:<payload>
    Client frames are newline-delimited JSON: {"to":"root","type":"listTabs"}\\n
    """
    def __init__(self, port):
        self.port = port
        self._sock = socket.create_connection(("127.0.0.1", port), timeout=6)
        # Blocking mode with a SHORT per-recv timeout + deadline accounting.
        # The v1 busy-wait (setblocking(False) + sleep(0.01)) swallowed
        # ConnectionResetError (subclass of OSError) — a wedged single-client
        # slot looked identical to "hello not arrived yet" and burned the full
        # 8s deadline. Blocking recv raises timeout/reset distinctly.
        self._sock.settimeout(1.0)
        self._buf = b""

    def _read_frame(self, total_deadline=8.0):
        """Read one length-prefixed server frame. Returns raw bytes or None.

        Blocking recv with a 1s per-recv timeout, looping until the total
        deadline. ConnectionResetError propagates (wedged slot — caller
        retries with a fresh forward); socket.timeout is retried until the
        deadline. This matches the proven bash recipe: nudge byte + hold the
        connection open; the hello arrives on the held-open socket.
        """
        buf = self._buf
        s = self._sock
        deadline = time.time() + total_deadline
        # Phase 1: read until the ":" separator (length prefix may split)
        while b":" not in buf:
            if time.time() >= deadline:
                return None
            try:
                d = s.recv(4096)
            except socket.timeout:
                continue
            # ConnectionResetError and other OSErrors propagate — a wedged
            # slot must be visible to the caller, not swallowed.
            if not d:
                return None
            buf += d
        i = buf.index(b":")
        # Parse length prefix
        try:
            n = int(buf[:i])
        except ValueError:
            return None
        # Phase 2: read the full payload
        while len(buf) < i + 1 + n:
            if time.time() >= deadline:
                return None
            try:
                d = s.recv(max(1, i + 1 + n - len(buf)))
            except socket.timeout:
                continue
            if not d:
                return None
            buf += d
        frame = buf[i+1 : i+1+n]
        self._buf = buf[i+1+n:]
        return frame
    
    def _send(self, msg: str):
        """Send an RDP command to the server.

        Firefox 159 dropped the barebone (newline-delimited) client transport —
        client messages MUST be length-prefixed: <len>:<json> (confirmed by
        vscode-firefox-debug's DebugProtocolTransport.sendMessage). The v1
        newline form is why listTabs got zero frames back.
        """
        payload = msg.encode()
        self._sock.sendall(str(len(payload)).encode() + b":" + payload)


    def recv(self) -> dict | None:
        """Read and parse a length-prefixed server response."""
        raw = self._read_frame()
        if raw is None:
            return None
        try:
            return json.loads(raw.decode())
        except json.JSONDecodeError:
            return None

    def recv_raw(self) -> bytes | None:
        """Read raw bytes without JSON parsing."""
        return self._read_frame()

    def drain_until(self, pred, timeout=5) -> dict | None:
        """Keep reading frames until pred(frame) returns True.

        This is critical because listTabs returns frameUpdate notifications
        before the actual response. You must drain to find the real reply.
        A frame that fails JSON parse (recv -> None) is SKIPPED, not fatal —
        v1 aborted the whole drain on the first unparseable frame.
        """
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            f = self.recv()
            if f is None:
                # Unparseable/absent frame: keep draining until the deadline.
                continue
            last = f
            if pred(f):
                return f
        return last

    def get_tabs(self) -> list[dict]:
        """Connect, list tabs, return tab list."""
        # Firefox 159: NO nudge byte — the server sends the hello immediately
        # on connect (the v1 'x' nudge desynced the transport detection).
        hello = self.recv()
        assert hello is not None, "no hello from server"
        assert hello.get("from") == "root", "hello not from root"

        # listTabs command (length-prefixed via _send — 159 dropped the
        # newline barebone transport)
        self._send('{"to":"root","type":"listTabs"}')
        # Drain notifications to find the tabs response
        resp = self.drain_until(lambda f: "tabs" in f, timeout=8)
        assert resp is not None, "no listTabs response"
        assert "tabs" in resp, "response has no tabs key"
        return resp["tabs"]

    def attach_tab(self, tab: dict) -> dict:
        """Attach to a tab, returns the frame."""
        self._send(json.dumps({"to": tab["actor"], "type": "attach"}))
        return self.recv()

    def get_target(self, tab: dict) -> str:
        """Get target frame, returns consoleActor string."""
        self._send(json.dumps({"to": tab["actor"], "type": "getTarget"}))
        result = self.recv()
        while result and "frame" not in result:
            result = self.recv()
        assert result is not None and "frame" in result
        return result["frame"]["consoleActor"]

    def eval_js(self, console_actor: str, expression: str, await_promise=True) -> dict:
        """Evaluate JS on console actor. Returns the evaluationResult frame."""
        self._send(json.dumps({
            "to": console_actor,
            "type": "evaluateJSAsync",
            "text": expression,
            "awaitPromise": await_promise
        }))
        # Read until we get evaluationResult
        for _ in range(60):
            f = self.recv()
            if f and f.get("type") == "evaluationResult":
                return f
        return None

    def close(self):
        self._sock.close()


def main():
    if len(sys.argv) < 2:
        print("Usage: rdp-driver.py <fennec-port>")
        print("Get port: adb forward tcp:0 localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket")
        sys.exit(1)

    port = int(sys.argv[1])
    r = FennecRDP(port)

    try:
        tabs = r.get_tabs()
        print(f"Found {len(tabs)} tabs")
        for t in tabs[:3]:
            print(f"  {t['actor'][:30]} ... {t.get('url','')[:60]}")

        # Use first tab with a URL
        main_tab = next((t for t in tabs if t.get("url") and "cloudflare" in t.get("url", "")), tabs[0])
        print(f"\nUsing tab: {main_tab.get('url','unknown')[:80]}")

        # Attach and get console actor
        r.attach_tab(main_tab)
        console = r.get_target(main_tab)
        print(f"Console actor: {console}")

        # Sync eval (returns immediately, no Promise)
        result = r.eval_js(console, "JSON.stringify({ok:true, href:location.href})")
        if result:
            print(f"Eval result: {result.get('result')}")
        else:
            print("No evaluationResult frame received")

    finally:
        r.close()


if __name__ == "__main__":
    main()
