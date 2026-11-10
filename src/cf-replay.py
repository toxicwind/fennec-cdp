#!/usr/bin/env python3
"""cf-replay.py — replay the exact URL the attacker used to reach the
account api-tokens page, headless, exit, full error output as hooked try/catch.

Navigates the fennec tab to the CF account api-tokens URL, waits for load,
and dumps: final href, login state, page title, any XHR error, and whether
the account api-tokens surface rendered. One shot, then exits.
"""
import os, sys, json, time, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib
_f = importlib.import_module("fennec-live")
FennecSession = _f.FennecSession

SERIAL = os.environ.get("ADB_SERIAL", "10.0.0.77:35093")
TARGET = os.environ.get("CF_TARGET", "https://dash.cloudflare.com/2d5e60dbc717af626a1eb04177aa2225/api-tokens")

NAV = """
(async()=>{try{
  const out={};
  const start=location.href;
  out.start=start;
  if(!start.includes('dash.cloudflare.com')){
    location.href='https://dash.cloudflare.com/';
    await new Promise(r=>{let n=0;const t=setInterval(()=>{n++;
      if(location.href.includes('dash.cloudflare.com')){clearInterval(t);r();}
      else if(n>60){clearInterval(t);r();}},250);});
  }
  location.href=%s;
  await new Promise(r=>{let n=0;const t=setInterval(()=>{n++;
    if(location.href.includes('api-tokens')){clearInterval(t);r();}
    else if(n>80){clearInterval(t);r();}},250);});
  await new Promise(r=>setTimeout(r,6000));
  out.final=location.href;
  out.title=document.title;
  out.body=document.body?document.body.innerText.slice(0,600):'';
  window.__OUT=JSON.stringify(out);
  return 'ok';
}catch(e){window.__OUT=JSON.stringify({err:String(e),stack:e&&e.stack});return 'ok';}
})()""" % json.dumps(TARGET)


def run(sess, expr, wait=60):
    js = ("(async()=>{try{" +
          "window.F=window.F||async(u,o)=>{const r=await fetch(u,Object.assign({credentials:'include'},o||{}));"
          "const t=await r.text();let j=null;try{j=JSON.parse(t)}catch(e){};"
          "if(!r.ok||!j){throw new Error('HTTP '+r.status+' '+u+' '+t.slice(0,200))}return j;};" +
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
        subprocess.run(["adb", "-s", SERIAL, "forward", "--remove",
                        "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                       capture_output=True)
        r = subprocess.run(["adb", "-s", SERIAL, "forward", "tcp:0",
                            "localabstract:org.mozilla.fennec_fdroid/firefox-debugger-socket"],
                           capture_output=True, text=True)
        port = int(r.stdout.strip().split(":")[-1])
    sess = FennecSession(port)
    res = run(sess, NAV)
    print(json.dumps({"replay": json.loads(res) if res else None}, indent=1))
    # second: confirm account api-tokens API access
    r2 = run(sess, "(await F('/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225/tokens')).result", wait=40)
    print(json.dumps({"account_tokens": json.loads(r2) if r2 else None}, indent=1))


if __name__ == "__main__":
    main()