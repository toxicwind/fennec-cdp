/**
 * rdp.ts — Fennec (Firefox for Android) Remote Debugging Protocol client.
 *
 * Ground truth (reconciled from 3 agreeing live implementations, NOT the stale
 * protocol.md/README which claimed newline-delimited sends + a nudge byte):
 *   - Server hello arrives PASSIVELY on connect (no nudge byte).
 *   - BOTH directions are length-prefixed frames: `<len>:<json>`.
 *   - Newline-delimited sends KILL the session (server stops replying).
 *   - Fennec accepts ONE debugger connection; a killed client wedges the slot
 *     until `adb forward --remove` + re-add, or force-stop fennec.
 */
import { Effect, Schema, Console } from "effect";
import * as net from "node:net";

export class RdpError extends Schema.TaggedError<RdpError>()("RdpError", {
  message: Schema.String,
}) {}

export class Rdp {
  readonly #socket: net.Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #consoleActor: string | null = null;
  #tabUrl: string | null = null;

  constructor(socket: net.Socket) {
    this.#socket = socket;
  }

  static connect(port: number): Effect.Effect<Rdp, RdpError> {
    return Effect.gen(function* () {
      yield* Console.log(`[rdp] connecting 127.0.0.1:${port}`);
      const socket = yield* Effect.tryPromise({
        try: () =>
          new Promise<net.Socket>((resolve, reject) => {
            const s = net.createConnection({ host: "127.0.0.1", port });
            s.once("connect", () => resolve(s));
            s.once("error", reject);
          }),
        catch: (e) =>
          new RdpError({ message: `connect :${port}: ${String(e)}` }),
      });
      const rdp = new Rdp(socket);
      yield* Console.log("[rdp] draining passive hello");
      yield* rdp.pump(2.0);
      yield* Console.log("[rdp] handshaking (listTabs -> getTarget -> consoleActor)");
      yield* rdp.handshake();
      yield* Console.log(`[rdp] handshake ok, tab: ${rdp.tabUrl}`);
      return rdp;
    });
  }

  /** Send a length-prefixed frame `<len>:<json>`. */
  send(obj: unknown): Effect.Effect<void, RdpError> {
    const socket = this.#socket;
    const b = Buffer.from(JSON.stringify(obj));
    const frame = Buffer.concat([
      Buffer.from(String(b.length)),
      Buffer.from(":"),
      b,
    ]);
    return Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          socket.write(frame, (err) => (err ? reject(err) : resolve()));
        }),
      catch: (e) => new RdpError({ message: `send: ${String(e)}` }),
    });
  }

  /** Read one chunk from the socket, resolving empty after `timeoutMs` if no data. */
  private readChunk(timeoutMs = 2500): Effect.Effect<Buffer, RdpError> {
    const socket = this.#socket;
    return Effect.tryPromise({
      try: () =>
        new Promise<Buffer>((resolve) => {
          const done = (d: Buffer) => {
            socket.removeListener("data", onData);
            socket.removeListener("end", onEnd);
            socket.removeListener("error", onError);
            clearTimeout(timer);
            resolve(d);
          };
          const onData = (d: Buffer) => done(d);
          const onEnd = () => done(Buffer.alloc(0));
          const onError = () => done(Buffer.alloc(0));
          const timer = setTimeout(() => done(Buffer.alloc(0)), timeoutMs);
          socket.once("data", onData);
          socket.once("end", onEnd);
          socket.once("error", onError);
        }),
      catch: (e) => new RdpError({ message: `recv: ${String(e)}` }),
    });
  }

  /** Read frames for up to `seconds`, returning parsed JSON. Stops early on `want`. */
  pump(seconds: number, want?: string): Effect.Effect<Array<unknown>, RdpError> {
    const self = this;
    const deadline = Date.now() + seconds * 1000;
    const out: Array<unknown> = [];
    const pumpLoop = (): Effect.Effect<Array<unknown>, RdpError> =>
      Effect.gen(function* () {
        if (Date.now() >= deadline) return out;
        const chunk = yield* self.readChunk();
        if (chunk.length === 0) return out;
        self.#buffer = Buffer.concat([self.#buffer, chunk]);
        for (;;) {
          const i = self.#buffer.indexOf(":");
          if (i < 0) break;
          const n = Number(self.#buffer.subarray(0, i).toString());
          if (Number.isNaN(n)) {
            self.#buffer = self.#buffer.subarray(i + 1);
            continue;
          }
          if (self.#buffer.length < i + 1 + n) break;
          const frame = self.#buffer.subarray(i + 1, i + 1 + n);
          self.#buffer = self.#buffer.subarray(i + 1 + n);
          try {
            const j = JSON.parse(frame.toString()) as unknown;
            out.push(j);
            if (want && frame.toString().includes(want)) return out;
          } catch {
            // skip malformed frame
          }
        }
        return yield* pumpLoop();
      });
    return pumpLoop();
  }

  /** listTabs -> pick CF (or first) tab -> getTarget -> consoleActor. */
  private handshake(): Effect.Effect<void, RdpError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.send({ to: "root", type: "listTabs" });
      const fs = yield* self.pump(6.0, '"tabs"');
      const tabs = fs.find(
        (j) =>
          typeof j === "object" && j !== null && "tabs" in (j as object),
      ) as { tabs?: Array<{ actor: string; url: string }> } | undefined;
      const list = tabs?.tabs ?? [];
      const cf = list.find((t) => t.url.includes("cloudflare"));
      const tab = cf ?? list[0];
      if (!tab) return yield* Effect.fail(new RdpError({ message: "no tabs" }));
      self.#tabUrl = tab.url;
      yield* self.send({ to: tab.actor, type: "getTarget" });
      const fs2 = yield* self.pump(8.0, "consoleActor");
      for (const j of fs2) {
        const frame = j as { frame?: { consoleActor?: string } };
        if (frame.frame?.consoleActor) {
          self.#consoleActor = frame.frame.consoleActor;
          break;
        }
      }
      if (!self.#consoleActor) {
        return yield* Effect.fail(new RdpError({ message: "no consoleActor" }));
      }
    });
  }

  get tabUrl(): string | null {
    return this.#tabUrl;
  }

  /**
   * Read a DevTools `longString` descriptor (`{type:"longString", actor,
   * length, initial}`) to its full text via the `substring` protocol command.
   * fennec returns large string values as longString objects; `evalSync` only
   * surfaces `initial` (~1000 chars). This fetches the remainder in chunks.
   */
  readLongString(desc: {
    actor: string;
    length: number;
    initial?: string;
  }): Effect.Effect<string, RdpError> {
    const self = this;
    const chunk = 100000;
    return Effect.gen(function* () {
      const parts: string[] = [];
      if (desc.initial) parts.push(desc.initial);
      let pos = desc.initial ? desc.initial.length : 0;
      while (pos < desc.length) {
        const end = Math.min(pos + chunk, desc.length);
        yield* self.send({
          to: desc.actor,
          type: "substring",
          start: pos,
          end,
        });
        const fs = yield* self.pump(6.0, "substring");
        let got: string | null = null;
        for (const j of fs) {
          const f = j as { substring?: string };
          if (typeof f.substring === "string") {
            got = f.substring;
            break;
          }
        }
        if (got === null) break;
        parts.push(got);
        pos = end;
      }
      return parts.join("");
    });
  }

  /** Evaluate `expr` (sync, awaitPromise). Returns the resolved result value. */
  evalSync(expr: string, wait = 20): Effect.Effect<unknown, RdpError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.send({
        to: self.#consoleActor,
        type: "evaluateJSAsync",
        text: expr,
        awaitPromise: true,
      });
      const fs = yield* self.pump(wait, "evaluationResult");
      let r: unknown = null;
      for (const j of fs) {
        const frame = j as { type?: string; result?: unknown };
        if (frame.type === "evaluationResult") r = frame.result;
      }
      return r;
    });
  }

  /**
   * Evaluate an async expression, writing the result to window.__OUT, then
   * poll until it is a non-pending string. Errors are captured as {err,url}.
   * Auto-navigates the tab to the CF dashboard if it drifted off it.
   */
  evalAsyncGlobal(expr: string, wait = 30): Effect.Effect<string | null, RdpError> {
    const self = this;
    const js =
      "(async()=>{try{" +
      "let here=location.href;" +
      "if(!here.includes('dash.cloudflare.com')){" +
      "location.href='https://dash.cloudflare.com/';" +
      "await new Promise(r=>{let n=0;const t=setInterval(()=>{n++;" +
      "if(location.href.includes('dash.cloudflare.com')&&document.readyState==='complete'){clearInterval(t);r();}" +
      "else if(n>40){clearInterval(t);r();}},250);});" +
      "here=location.href;" +
      "if(!here.includes('dash.cloudflare.com')){" +
      "window.__OUT=JSON.stringify({err:'wrong-page',url:here});return 'ok';}}" +
      "window.F=window.F||async(u,o)=>{const r=await fetch(u,Object.assign({credentials:'include'},o||{}));" +
      "const t=await r.text();let j=null;try{j=JSON.parse(t)}catch(e){};" +
      "if(!r.ok||!j){throw new Error('HTTP '+r.status+' '+u+' '+(j&&j.errors?JSON.stringify(j.errors):t.slice(0,150)))}" +
      "return j;};" +
      `const d=${expr};` +
      "window.__OUT=typeof d==='string'?d:JSON.stringify(d);" +
      "}catch(e){window.__OUT=JSON.stringify({err:String(e),url:location.href});}" +
      "return 'ok';})()";
    return Effect.gen(function* () {
      yield* self.send({
        to: self.#consoleActor,
        type: "evaluateJSAsync",
        text: js,
        awaitPromise: true,
      });
      yield* self.pump(3);
      yield* Effect.sleep("1.5 seconds");
      const deadline = Date.now() + Math.min(wait, 30) * 1000;
      while (Date.now() < deadline) {
        const r = yield* self.evalSync(
          "typeof window.__OUT==='string'?window.__OUT:'pending'",
          5,
        );
        if (typeof r === "string" && r !== "pending" && r !== "ok") return r;
        yield* Effect.sleep("400 millis");
      }
      return null;
    });
  }

  /**
   * Navigate the tab to `url` and wait until location matches `match`, then
   * settle. Returns the final href.
   */
  navigate(
    url: string,
    match: string,
    settleMs = 6000,
  ): Effect.Effect<string | null, RdpError> {
    const self = this;
    const js =
      "(async()=>{const T=(ms,fn)=>Promise.race([Promise.resolve().then(fn),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout '+ms)),ms))]);" +
      "try{" +
      "const out={};" +
      "let start=await T(5000,()=>location.href);out.start=start;" +
      "if(!start.includes('dash.cloudflare.com')){" +
      "location.href='https://dash.cloudflare.com/';" +
      "await T(15000,()=>new Promise(r=>{let n=0;const t=setInterval(()=>{n++;" +
      "if(location.href.includes('dash.cloudflare.com')){clearInterval(t);r();}" +
      "else if(n>60){clearInterval(t);r();}},250);}));}" +
      `location.href=${JSON.stringify(url)};` +
      "await T(20000,()=>new Promise(r=>{let n=0;const t=setInterval(()=>{n++;" +
      `if(location.href.includes(${JSON.stringify(match)})){clearInterval(t);r();}` +
      "else if(n>80){clearInterval(t);r();}},250);}));" +
      `await T(${settleMs},()=>new Promise(r=>setTimeout(r,${settleMs})));` +
      "out.final=await T(5000,()=>location.href);" +
      "out.title=await T(5000,()=>document.title);" +
      "out.body=await T(5000,()=>document.body?document.body.innerText.slice(0,600):'');" +
      "window.__OUT=JSON.stringify(out);return 'ok';" +
      "}catch(e){window.__OUT=JSON.stringify({err:String(e),stack:e&&e.stack});return 'ok';}" +
      "})()";
    return Effect.gen(function* () {
      yield* self.send({
        to: self.#consoleActor,
        type: "evaluateJSAsync",
        text: js,
        awaitPromise: true,
      });
      yield* self.pump(3);
      yield* Effect.sleep("1.5 seconds");
      const deadline = Date.now() + 60 * 1000;
      while (Date.now() < deadline) {
        const r = yield* self.evalSync(
          "typeof window.__OUT==='string'?window.__OUT:'pending'",
          5,
        );
        if (typeof r === "string" && r !== "pending" && r !== "ok") {
          try {
            return (JSON.parse(r) as { final?: string }).final ?? null;
          } catch {
            return null;
          }
        }
        yield* Effect.sleep("400 millis");
      }
      return null;
    });
  }

  close(): void {
    try {
      this.#socket.destroy();
    } catch {
      // ignore
    }
  }
}

export const makeRdp = Rdp.connect;