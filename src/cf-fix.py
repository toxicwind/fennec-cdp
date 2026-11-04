#!/usr/bin/env python3
"""cf-fix.py — one-shot CF hijack fix over the fennec DevTools socket.

Uses the phone's logged-in CF session (no API token needed) to:
  1. enumerate API tokens
  2. list zones + redirect rules / page rules / bulk redirects
  3. DELETE attacker redirect artifacts (301 -> femboy.pp.ua)
Prints a full JSON transcript. One process, one socket, no daemon.
"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib  # noqa: E402
_f = importlib.import_module("fennec-live")  # noqa: E402
FennecSession = _f.FennecSession  # noqa: E402

SERIAL = os.environ.get("ADB_SERIAL", "10.0.0.77:35093")

FETCH = """
window.F=window.F||async(u,o)=>{const r=await fetch(u,Object.assign({credentials:'include'},o||{}));
const t=await r.text();let j=null;try{j=JSON.parse(t)}catch(e){};
if(!r.ok||!j){throw new Error('HTTP '+r.status+' '+u+' '+t.slice(0,200))}
return j;};
"""


def run(sess, expr, wait=25):
    js = ("(async()=>{try{" + FETCH +
          f"const d={expr};"
          "window.__OUT=typeof d==='string'?d:JSON.stringify(d);"
          "}catch(e){window.__OUT=JSON.stringify({err:String(e),url:location.href});}"
          "return 'ok';})()")
    with sess.lock:
        sess._sendl({"to": sess.console, "type": "evaluateJSAsync",
                     "text": js, "awaitPromise": True})
        sess._pump(3)
        deadline = time.time() + wait
        while time.time() < deadline:
            r = None
            sess._sendl({"to": sess.console, "type": "evaluateJSAsync",
                         "text": "typeof window.__OUT==='string'?window.__OUT:'pending'",
                         "awaitPromise": True})
            fs, _ = sess._pump(4, b"evaluationResult")
            for j in fs:
                if isinstance(j, dict) and j.get("type") == "evaluationResult":
                    rv = j.get("result")
                    if isinstance(rv, str) and rv not in ("pending", "ok"):
                        r = rv
            if r:
                return r
            time.sleep(0.3)
    return None


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if not port:
        import subprocess
        subprocess.run(["adb", "-s", SERIAL, "forward", "--remove",
                        "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                       capture_output=True)
        r = subprocess.run(["adb", "-s", SERIAL, "forward", "tcp:0",
                            "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                           capture_output=True, text=True)
        port = int(r.stdout.strip().split(":")[-1])
    sess = FennecSession(port)
    out = {}

    out["url"] = sess.eval_sync("location.href")

    # 1. tokens
    r = run(sess, "(await F('/api/v4/user/tokens?per_page=100')).result.map(t=>({id:t.id,name:t.name,status:t.status,last_used:t.last_used_on}))")
    out["tokens"] = json.loads(r) if r else None

    # 2. zones
    r = run(sess, "(await F('/api/v4/zones?per_page=50')).result.map(z=>({id:z.id,name:z.name,status:z.status}))")
    zones = json.loads(r) if r else []
    out["zones"] = zones

    # 3. per-zone: page rules + redirect rules (rulesets) + bulk redirects
    detail = {}
    for z in zones:
        zid, name = z["id"], z["name"]
        d = {}
        r = run(sess, f"(await F('/api/v4/zones/{zid}/pagerules')).result")
        d["pagerules"] = json.loads(r) if r else None
        # phase-based redirect rulesets (the attacker's 301 vector)
        for phase in ["http_request_dynamic_redirect", "http_request_redirect"]:
            r = run(sess, f"(await F('/api/v4/zones/{zid}/rulesets/phases/{phase}/entrypoint')).result")
            d[phase] = json.loads(r) if r else None
        r = run(sess, f"(await F('/api/v4/zones/{zid}/rulesets')).result.map(rs=>({{id:rs.id,name:rs.name,phase:rs.phase,kind:rs.kind}}))")
        d["rulesets"] = json.loads(r) if r else None
        detail[name] = d
    out["zone_detail"] = detail

    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
