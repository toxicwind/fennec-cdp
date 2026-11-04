#!/usr/bin/env python3
"""
fennec-cdp: full fennec RDP session (the working protocol, proven).

The protocol (verified live):
- Server hello arrives PASSIVELY on connect (no nudge!)
- Both directions are LENGTH-PREFIXED frames (<len>:<json>)
- Newline-delimited sends KILL the session (server stops replying)

Usage:
  fennec-forward.sh                 # fresh forward
  python3 fennec-session.py <port> <command>

Commands: whoami | cookies | zones | pagerules <zone-id> | eval '<expr>'
"""
import socket, json, sys, time, argparse


class FennecRDP:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=6)
        self.s.settimeout(0.8)
        self.buf = b""
        self.console = None

    def _frames(self, seconds, stop_val=None):
        """Read frames for `seconds` max, or until stop_val seen in a frame.
        Returns parsed JSON list."""
        out = []
        dl = time.time() + seconds
        while time.time() < dl:
            try:
                d = self.s.recv(65536)
                if not d:
                    break
                self.buf += d
            except socket.timeout:
                continue
            except Exception:
                break
            while True:
                i = self.buf.find(b":")
                if i < 0:
                    break
                try:
                    n = int(self.buf[:i])
                except ValueError:
                    self.buf = self.buf[i+1:]
                    continue
                if len(self.buf) < i + 1 + n:
                    break
                fr = self.buf[i+1:i+1+n]
                self.buf = self.buf[i+1+n:]
                try:
                    j = json.loads(fr)
                    out.append(j)
                    if stop_val and stop_val in fr:
                        return out, True
                except Exception:
                    pass
        return out, False

    def sendl(self, obj):
        b = json.dumps(obj).encode()
        self.s.sendall(str(len(b)).encode() + b":" + b)

    def handshake(self, url_hint="cloudflare"):
        """Passive hello -> listTabs -> getTarget -> consoleActor."""
        self._frames(2.0)  # drain passive hello
        self.sendl({"to": "root", "type": "listTabs"})
        fs, _ = self._frames(6.0, b'"tabs"')
        tabs = []
        for j in fs:
            if "tabs" in j:
                tabs = j["tabs"]
        if not tabs:
            raise RuntimeError("no tabs")
        cf = next((t for t in tabs if url_hint in t.get("url", "")), None)
        self.tab = cf or tabs[0]
        self.sendl({"to": self.tab["actor"], "type": "getTarget"})
        fs2, _ = self._frames(8.0, b"consoleActor")
        for j in fs2:
            if j.get("frame", {}).get("consoleActor"):
                self.console = j["frame"]["consoleActor"]
        if not self.console:
            raise RuntimeError("no consoleActor")
        return self.tab

    def eval_result(self, expr, wait=20):
        """Send eval, drain until evaluationResult, return result value."""
        self.sendl({"to": self.console, "type": "evaluateJSAsync",
                    "text": expr, "awaitPromise": True})
        fs, _ = self._frames(wait, b"evaluationResult")
        # may return a Promise ref first; drain more for the resolved value
        r = None
        for j in fs:
            if j.get("type") == "evaluationResult":
                r = j.get("result")
        if isinstance(r, str):
            return r
        if r is None:
            return None
        return json.dumps(r)

    def eval_async_global(self, expr, wait=30):
        """Async expr -> window.__OUT -> poll sync until string."""
        js = (f"(async()=>{{try{{const d={expr};"
              f"window.__OUT=typeof d==='string'?d:JSON.stringify(d);}}"
              f"catch(e){{window.__OUT=JSON.stringify({{err:String(e)}});}}"
              f"return 'ok';}})()")
        self.sendl({"to": self.console, "type": "evaluateJSAsync",
                    "text": js, "awaitPromise": True})
        self._frames(3.0)
        time.sleep(1.5)
        for _ in range(12):
            r = self.eval_result("typeof window.__OUT==='string'?window.__OUT:'pending'", wait=10)
            if isinstance(r, str) and r != "pending":
                return r
            time.sleep(0.4)
        return None

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int)
    ap.add_argument("cmd", choices=["whoami", "cookies", "probe", "eval", "async"])
    ap.add_argument("expr", nargs="?", help="JS expression for eval/async cmds")
    a = ap.parse_args()

    r = FennecRDP(a.port)
    tab = r.handshake()
    print(f"# tab: {tab.get('url','')[:80]}", file=sys.stderr)

    if a.cmd == "probe":
        print(r.eval_result('JSON.stringify({ok:1,href:location.href})'))
    elif a.cmd == "whoami":
        print(r.eval_async_global("(await (await fetch('/client/v4/user')).json()).result"))
    elif a.cmd == "cookies":
        print(r.eval_result("document.cookie"))
    elif a.cmd == "eval":
        print(r.eval_result(a.expr))
    elif a.cmd == "async":
        print(r.eval_async_global(a.expr))

    r.close()


if __name__ == "__main__":
    main()
