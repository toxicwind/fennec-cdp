#!/usr/bin/env python3
"""
fennec-live — long-lived RDP session daemon (owns the socket; survives cell aborts).

Endpoints:
  GET /health                → {"ok":true, "console":..., "tab":...}
  GET /eval?expr=<js>        → sync eval result (string)
  GET /async?expr=<js>       → async expr → window.__OUT poll → string
  GET /cookies               → document.cookie
  GET /whoami                → /api/v4/user via page context
  GET /pagerules             → zones + page rules for all zones (the mission)

Usage: python3 fennec-live.py 25161
Fresh forward first: bin/fennec-forward.sh
"""
import socket, json, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote


class FennecSession:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=6)
        self.s.settimeout(0.9)
        self.buf = b""
        self.console = None
        self.tab = None
        self.lock = threading.Lock()
        self._handshake()

    def _sendl(self, o):
        b = json.dumps(o).encode()
        self.s.sendall(str(len(b)).encode() + b":" + b)

    def _pump(self, seconds, want=None):
        out = []
        dl = time.time() + seconds
        hit = False
        while time.time() < dl:
            try:
                d = self.s.recv(65536)
            except socket.timeout:
                continue
            except Exception:
                break
            self.buf += d
            if want and want in d:
                hit = True
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
                    if want and want in fr:
                        hit = True
                except Exception:
                    pass
        return out, hit

    def _handshake(self):
        self._pump(2.5)  # passive hello
        self._sendl({"to": "root", "type": "listTabs"})
        fs, _ = self._pump(6, b'"tabs"')
        tabs = []
        for j in fs:
            if isinstance(j, dict) and "tabs" in j:
                tabs = j["tabs"]
        cf = next((t for t in tabs if "cloudflare" in t.get("url", "")), None)
        self.tab = cf or (tabs[0] if tabs else None)
        if not self.tab:
            raise RuntimeError("no tabs")
        self._sendl({"to": self.tab["actor"], "type": "getTarget"})
        fs, _ = self._pump(8, b"consoleActor")
        for j in fs:
            if isinstance(j, dict) and j.get("frame", {}).get("consoleActor"):
                self.console = j["frame"]["consoleActor"]
        if not self.console:
            raise RuntimeError("no consoleActor")

    def eval_sync(self, expr, wait=20):
        with self.lock:
            self._sendl({"to": self.console, "type": "evaluateJSAsync",
                         "text": expr, "awaitPromise": True})
            fs, _ = self._pump(wait, b"evaluationResult")
            for j in fs:
                if isinstance(j, dict) and j.get("type") == "evaluationResult":
                    return j.get("result")
            return None

    def eval_async_global(self, expr, wait=40):
        deadline = time.time() + min(wait, 30)
        with self.lock:
            # Context guard: evals must run on the CF dashboard. If the tab
            # drifted (error page, about:blank), report it instead of returning
            # a raw HTML error body.
            js = ("(async()=>{try{"
                  "let here=location.href;"
                  "if(!here.includes('dash.cloudflare.com')){"
                  "location.href='https://dash.cloudflare.com/';"
                  "await new Promise(r=>{let n=0;const t=setInterval(()=>{"
                  "n++;if(location.href.includes('dash.cloudflare.com')&&document.readyState==='complete'){clearInterval(t);r();}"
                  "else if(n>40){clearInterval(t);r();}},250);});"
                  "here=location.href;"
                  "if(!here.includes('dash.cloudflare.com')){"
                  "window.__OUT=JSON.stringify({err:'wrong-page',url:here});return 'ok';}}"
                  "window.F=window.F||async(u,o)=>{const r=await fetch(u,Object.assign({credentials:'include'},o||{}));"
                  "const t=await r.text();let j=null;try{j=JSON.parse(t)}catch(e){};"
                  "if(!r.ok||!j){throw new Error('HTTP '+r.status+' '+u+' '+(j&&j.errors?JSON.stringify(j.errors):t.slice(0,150)))}"
                  "return j;};"
                  f"const d={expr};"
                  "window.__OUT=typeof d==='string'?d:JSON.stringify(d);"
                  "}catch(e){window.__OUT=JSON.stringify({err:String(e),url:location.href});}"
                  "return 'ok';})()")
            self._sendl({"to": self.console, "type": "evaluateJSAsync",
                         "text": js, "awaitPromise": True})
            self._pump(3)
            time.sleep(1.5)
            while time.time() < deadline:
                r = None
                self._sendl({"to": self.console, "type": "evaluateJSAsync",
                             "text": "typeof window.__OUT==='string'?window.__OUT:'pending'",
                             "awaitPromise": True})
                fs, _ = self._pump(5, b"evaluationResult")
                for j in fs:
                    if isinstance(j, dict) and j.get("type") == "evaluationResult":
                        rv = j.get("result")
                        if isinstance(rv, str) and rv not in ("pending", "ok"):
                            r = rv
                if r:
                    return r
                time.sleep(0.4)
            return None

    def alive(self):
        try:
            return self.eval_sync("1", wait=6) == 1
        except Exception:
            return False


SESS = None
SESS_LOCK = threading.Lock()


def get_session():
    global SESS
    with SESS_LOCK:
        if SESS and SESS.alive():
            return SESS
        if SESS:
            try:
                SESS.s.close()
            except Exception:
                pass
        # fresh forward
        import subprocess, os
        serial = os.environ.get("ADB_SERIAL", "10.0.0.77:35093")
        subprocess.run(["adb", "-s", serial, "forward", "--remove",
                        "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                       capture_output=True)
        r = subprocess.run(["adb", "-s", serial, "forward", "tcp:0",
                            "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                           capture_output=True, text=True)
        port = int(r.stdout.strip().split(":")[-1])
        SESS = FennecSession(port)
        return SESS


MISSION_JS = """(async()=>{
  const o={};
  try{
    const z=await F('/api/v4/zones?per_page=50');
    o.zok=z.success;
    o.zones=(z.result||[]).map(zz=>({id:zz.id,name:zz.name}));
  }catch(e){o.zerr=String(e);window.__OUT=JSON.stringify(o);return 'ok';}
  const rules={};
  for(const zz of o.zones){
    try{
      const pr=await F('/api/v4/zones/'+zz.id+'/pagerules');
      rules[zz.name]=pr.success?(pr.result||[]).map(r=>({id:r.id,st:r.status,url:(r.targets&&r.targets[0]&&r.targets[0].constraint)?r.targets[0].constraint.value:''})):pr.errors;
    }catch(e){rules[zz.name]=String(e)}
  }
  o.rules=rules;
  window.__OUT=JSON.stringify(o);
  return 'ok';
})()"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/health":
                try:
                    s = get_session()
                    self._json({"ok": True, "console": s.console,
                                "tab": (s.tab or {}).get("url", "")[:80]})
                except Exception as e:
                    self._json({"ok": False, "err": str(e)}, 503)
            elif u.path == "/reset":
                global SESS
                with SESS_LOCK:
                    if SESS:
                        try:
                            SESS.s.close()
                        except Exception:
                            pass
                    SESS = None
                self._json({"reset": True})
            elif u.path == "/eval":
                s = get_session()
                expr = unquote(q["expr"][0])
                self._json({"result": s.eval_sync(expr)})
            elif u.path == "/async":
                s = get_session()
                expr = unquote(q["expr"][0])
                self._json({"result": s.eval_async_global(expr)})
            elif u.path == "/cookies":
                s = get_session()
                self._json({"cookies": s.eval_sync("document.cookie")})
            elif u.path == "/whoami":
                s = get_session()
                self._json({"whoami": s.eval_async_global(
                    "(await F('/api/v4/user'))")})
            elif u.path == "/pagerules":
                s = get_session()
                r = s.eval_async_global(MISSION_JS, wait=60)
                self._json({"pagerules": json.loads(r) if r else None})
            else:
                self._json({"err": "unknown route"}, 404)
        except Exception as e:
            try:
                self._json({"err": str(e)}, 500)
            except Exception:
                pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 25161
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
