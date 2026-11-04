import { Effect, Console } from "effect";
import { Rdp } from "./rdp.ts";
const port = Number(process.argv[2]);
const ACC = "2d5e60dbc717af626a1eb04177aa2225";
const main = Effect.gen(function* () {
  const rdp = yield* Rdp.connect(port);
  yield* Console.log(`[m] tab: ${rdp.tabUrl}`);
  // Test GET page rules for one zone (effusionlabs.com c708fbb6fcae2c3ebe33049b85cf3309)
  const zone = "c708fbb6fcae2c3ebe33049b85cf3309";
  const tests: Array<[string,string]> = [
    ["GET pagerules", `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/zones/${zone}/pagerules',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()`],
    ["GET rulesets", `(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/v4/zones/${zone}/rulesets',false);x.send();window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|ERR';return 'ok';}})()`],
  ];
  for (const [name, js] of tests) {
    yield* rdp.evalSync(js, 20);
    yield* Effect.sleep("300 millis");
    const g = yield* rdp.evalSync("(function(){return window.__OUT;})()", 20);
    let text = "";
    if (typeof g === "string") text = g;
    else if (g && typeof g === "object" && (g as any).type === "longString") text = yield* rdp.readLongString(g as any);
    const pipe = text.indexOf("|");
    const status = pipe > 0 ? text.slice(0, pipe) : "?";
    const body = pipe > 0 ? text.slice(pipe+1) : text;
    yield* Console.log(`[${name}] status ${status}`);
    yield* Console.log(`[${name}] body: ${body.slice(0, 500)}`);
  }
  rdp.close();
});
Effect.runPromise(main).catch(e => { console.error("FATAL", e); process.exit(1); });
