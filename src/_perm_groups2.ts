import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[pg] tab: ${rdp.tabUrl}`);
  const paths = [
    "/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225/tokens/permission_groups",
    "/api/v4/user/tokens/permission_groups",
    "/api/v4/accounts/2d5e60dbc717af626a1eb04177aa2225/permission_groups",
  ];
  for (const path of paths) {
    const setJs = `(function(){try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(path)},false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()`;
    yield* rdp.evalSync(setJs, 20);
    yield* Effect.sleep("300 millis");
    const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 20);
    let text = "";
    if (typeof g === "string") text = g;
    else if (g && typeof g === "object" && (g as any).type === "longString") text = yield* rdp.readLongString(g as any);
    const pipe = text.indexOf("|");
    const status = pipe > 0 ? text.slice(0, pipe) : "?";
    const body = pipe > 0 ? text.slice(pipe+1) : text;
    yield* Console.log(`[pg] ${path} -> status ${status}`);
    if (status === "200") {
      try {
        const env = JSON.parse(body);
        const groups = env.result || [];
        yield* Console.log(`[pg]   count ${groups.length}`);
        yield* Console.log(`[pg]   sample: ${JSON.stringify(groups.slice(0,3))}`);
      } catch(e) { yield* Console.log(`[pg]   parse err ${String(e)}`); }
    } else {
      yield* Console.log(`[pg]   body: ${body.slice(0,150)}`);
    }
  }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
