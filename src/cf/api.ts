/**
 * cf/api.ts — Cloudflare API driven through the logged-in fennec page context.
 *
 * Runs the dashboard's own cookie-authenticated `/api/v4/*` calls inside the
 * live fennec tab (the session that survives), via the guarded `F()` fetch
 * helper that surfaces HTTP status + errors instead of raw HTML.
 */
import { Effect, Schema } from "effect";
import type { Rdp } from "../rdp.ts";

export const CfUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  username: Schema.String,
  organizations: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, role: Schema.String }),
  ),
  modified_on: Schema.String,
});

export const CfToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  last_used_on: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.String),
});

export const CfZone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
});

export const CfPageRule = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  targets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        constraint: Schema.optional(
          Schema.Struct({ value: Schema.String }),
        ),
      }),
    ),
  ),
});

export const CfRuleset = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  phase: Schema.String,
  kind: Schema.String,
  rules: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        action: Schema.String,
        expression: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/**
 * Run `expr` (a JS expression returning JSON) through a SYNCHRONOUS XHR in the
 * live fennec page context. Sync XHR is the ONLY path proven to round-trip
 * reliably (async fetch/`evalAsyncGlobal` returns null — the awaited promise
 * is never surfaced by fennec's DevTools). We use the set-then-read `__OUT`
 * pattern (proven for both small and large responses): eval #1 performs the
 * XHR and writes `status|body` into `window.__OUT`; eval #2 reads it back as a
 * plain string. Every step is wrapped in try/catch inside the page so a
 * failure surfaces as a parseable marker instead of hanging.
 */
export function cfEval<T>(
  rdp: Rdp,
  expr: string,
  schema: Schema.Schema<T> & { readonly "DecodingServices": never },
  wait = 20,
): Effect.Effect<T, Error> {
  const isUrl = expr.trim().startsWith("/");
  const url = isUrl ? expr.trim() : null;
  // eval #1: perform the request, store `status|body` in window.__OUT.
  const setJs = url
    ? `(function(){try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url)},false);x.send();` +
      `window.__OUT=x.status+'|'+x.responseText;return 'ok';}catch(e){window.__OUT='0|XHR-ERR:'+String(e);return 'ok';}})()`
    : `(function(){try{var r=${expr};window.__OUT='200|'+JSON.stringify(r);return 'ok';}catch(e){window.__OUT='0|EVAL-ERR:'+String(e);return 'ok';}})()`;
  

  const setEff = Effect.tryPromise({
    try: () => rdp.evalSync(setJs, wait).pipe(Effect.runPromise),
    catch: (e) => new Error(`cfEval:set: ${String(e)}`),
  });
  // get-eval returns the __OUT value; fennec may give a `longString`
  // descriptor for large bodies, so we return the raw value (not a string
  // coercion) and let the reader pull the full text.
  const getEff = Effect.tryPromise({
    try: () =>
      rdp
        .evalSync("(function(){return window.__OUT;})()", wait)
        .pipe(Effect.runPromise),
    catch: (e) => new Error(`cfEval:get: ${String(e)}`),
  });

  return Effect.gen(function* () {
    yield* setEff;
    // Poll __OUT until it carries a status prefix (or a marker), so a slow
    // sync XHR never races the read. Deadline-bounded, fail-fast.
    let text = "";
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline) {
      const raw = yield* getEff;
      if (typeof raw === "string") {
        text = raw;
      } else if (
        raw !== null &&
        typeof raw === "object" &&
        "type" in (raw as Record<string, unknown>) &&
        (raw as { type?: string }).type === "longString"
      ) {
        // Pull the full body via the longString actor.
        const full = yield* rdp
          .readLongString(raw as { actor: string; length: number; initial?: string })
          .pipe(
            Effect.match({
              onFailure: () => "",
              onSuccess: (v) => v,
            }),
          );
        text = full;
      } else if (raw !== null && typeof raw === "object") {
        try {
          text = JSON.stringify(raw);
        } catch {
          text = "";
        }
      } else {
        text = "";
      }
      if (text === "NONE" || text === "") {
        yield* Effect.sleep("250 millis");
        continue;
      }
      const pipe = text.indexOf("|");
      if (pipe > 0 && /^\d+$/.test(text.slice(0, pipe))) break;
      if (text.startsWith("0|")) break; // XHR/EVAL error marker
      // Not yet a status-prefixed frame; keep polling.
      yield* Effect.sleep("250 millis");
    }
    if (text === "NONE" || text === "") {
      return yield* Effect.fail(new Error("cfEval: __OUT not set"));
    }
    const pipe = text.indexOf("|");
    if (pipe < 0) return yield* Effect.fail(new Error(`cfEval: bad shape: ${text.slice(0, 200)}`));
    const status = Number(text.slice(0, pipe));
    const body = text.slice(pipe + 1);
    if (status !== 200) {
      return yield* Effect.fail(new Error(`cfEval: HTTP ${status}: ${body.slice(0, 300)}`));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return yield* Effect.fail(new Error(`cfEval: non-JSON: ${body.slice(0, 200)}`));
    }
    // CF API returns a `{result, success, errors, messages}` envelope.
    let payload: unknown = parsed;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in (parsed as Record<string, unknown>)
    ) {
      payload = (parsed as { result: unknown }).result;
    }
    try {
      return yield* Effect.succeed(Schema.decodeUnknownSync(schema)(payload));
    } catch (e) {
      return yield* Effect.fail(new Error(`cfEval: schema: ${String(e)}`));
    }
  });
}

export const whoami = (rdp: Rdp): Effect.Effect<typeof CfUser.Type, Error> =>
  cfEval(rdp, "/api/v4/user", CfUser);

export const listTokens = (
  rdp: Rdp,
): Effect.Effect<ReadonlyArray<typeof CfToken.Type>, Error> =>
  cfEval(rdp, "/api/v4/user/tokens?per_page=100", Schema.Array(CfToken));

export const listZones = (
  rdp: Rdp,
): Effect.Effect<ReadonlyArray<typeof CfZone.Type>, Error> =>
  cfEval(rdp, "/api/v4/zones?per_page=50", Schema.Array(CfZone));

export const listPageRules = (
  rdp: Rdp,
  zoneId: string,
): Effect.Effect<ReadonlyArray<typeof CfPageRule.Type>, Error> =>
  cfEval(rdp, `/api/v4/zones/${zoneId}/pagerules`, Schema.Array(CfPageRule));

export const listRulesets = (
  rdp: Rdp,
  zoneId: string,
): Effect.Effect<ReadonlyArray<typeof CfRuleset.Type>, Error> =>
  cfEval(rdp, `/api/v4/zones/${zoneId}/rulesets`, Schema.Array(CfRuleset));

/** Full recon: whoami + zones + per-zone page rules + rulesets. */
export function recon(
  rdp: Rdp,
): Effect.Effect<
  {
    user: typeof CfUser.Type;
    zones: ReadonlyArray<typeof CfZone.Type>;
    detail: Record<string, unknown>;
  },
  Error
> {
  return Effect.gen(function* () {
    const user = yield* whoami(rdp);
    const zones = yield* listZones(rdp);
    const detail: Record<string, unknown> = {};
    for (const z of zones) {
      const pr = yield* listPageRules(rdp, z.id).pipe(
        Effect.match({
          onFailure: (e) => String(e),
          onSuccess: (v) => v,
        }),
      );
      const rs = yield* listRulesets(rdp, z.id).pipe(
        Effect.match({
          onFailure: (e) => String(e),
          onSuccess: (v) => v,
        }),
      );
      detail[z.name] = { pageRules: pr, rulesets: rs };
    }
    return { user, zones, detail };
  });
}