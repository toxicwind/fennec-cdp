#!/usr/bin/env python3
"""
fennec-cdp: cf-extract — pull zones + page rules through the LIVE CF session.

Runs the dashboard's own cookie-authenticated /api/v4 calls inside the logged-in
fennec tab (the session that survives), returns JSON.

Usage:
  P=$(bin/fennec-forward.sh)
  python3 src/cf-extract.py $P
"""
import socket, json, sys, time


def run(port):
    s = socket.create_connection(("127.0.0.1", port), timeout=6)
    s.settimeout(0.9)
    buf = b""

    def sendl(o):
        b = json.dumps(o).encode()
        s.sendall(str(len(b)).encode() + b":" + b)

    def pump(seconds, want=None):
        out = []
        dl = time.time() + seconds
        hit = False
        while time.time() < dl:
            try:
                d = s.recv(65536)
                if want:
                    buf_ = d
                    if want in buf_:
                        hit = True
            except socket.timeout:
                continue
            except Exception:
                break
            buf += d
            if want and want in d:
                hit = True
            while True:
                i = buf.find(b":")
                if i < 0:
                    break
                try:
                    n = int(buf[:i])
                except ValueError:
                    buf = buf[i+1:]
                    continue
                if len(buf) < i + 1 + n:
                    break
                fr = buf[i+1:i+1+n]
                buf = buf[i+1+n:]
                try:
                    out.append(json.loads(fr))
                except Exception:
                    pass
        return out, hit

    pump(2.5)  # passive hello
    sendl({"to": "root", "type": "listTabs"})
    fs, _ = pump(6, b'"tabs"')
    tabs = []
    for j in fs:
        if isinstance(j, dict) and "tabs" in j:
            tabs = j["tabs"]
    cf = next((t for t in tabs if "cloudflare" in t.get("url", "")), None)
    if not cf:
        print(json.dumps({"error": "no CF tab", "tabs": [t.get("url", "")[:50] for t in tabs]}))
        return
    sendl({"to": cf["actor"], "type": "getTarget"})
    console = None
    fs, _ = pump(8, b"consoleActor")
    for j in fs:
        if isinstance(j, dict) and j.get("frame", {}).get("consoleActor"):
            console = j["frame"]["consoleActor"]
    if not console:
        print(json.dumps({"error": "no consoleActor"}))
        return

    js = """(async()=>{
  const o={};
  try{
    const z=await(await fetch('/api/v4/zones?per_page=50',{credentials:'include'})).json();
    o.zok=z.success;
    o.zones=(z.result||[]).map(zz=>({id:zz.id,name:zz.name}));
  }catch(e){o.zerr=String(e);window.__OUT=JSON.stringify(o);return 'ok';}
  const rules={};
  for(const zz of o.zones){
    try{
      const pr=await(await fetch('/api/v4/zones/'+zz.id+'/pagerules',{credentials:'include'})).json();
      rules[zz.name]=pr.success?(pr.result||[]).map(r=>({id:r.id,st:r.status,url:(r.targets&&r.targets[0]&&r.targets[0].constraint)?r.targets[0].constraint.value:''})):pr.errors;
    }catch(e){rules[zz.name]=String(e)}
  }
  o.rules=rules;
  window.__OUT=JSON.stringify(o);
  return 'ok';
})()"""
    sendl({"to": console, "type": "evaluateJSAsync", "text": js, "awaitPromise": True})
    time.sleep(5)
    out = None
    dl = time.time() + 40
    while time.time() < dl and not out:
        sendl({"to": console, "type": "evaluateJSAsync",
               "text": "typeof window.__OUT==='string'?window.__OUT:'pending'",
               "awaitPromise": True})
        fs, _ = pump(5, b"evaluationResult")
        for j in fs:
            if isinstance(j, dict) and j.get("type") == "evaluationResult":
                r = j.get("result")
                if isinstance(r, str) and r not in ("pending", "ok"):
                    out = r
        time.sleep(0.4)
    s.close()
    print(out if out else json.dumps({"error": "NO_RESULT"}))


if __name__ == "__main__":
    run(int(sys.argv[1]))
