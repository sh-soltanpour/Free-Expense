# Reference

Full documentation for [Free Expense](../README.md).

## Rules

Each rule is a matcher plus an ordered list of changes applied to the parsed
JSON body.

| Field | Meaning |
| --- | --- |
| **Method** | `Any`, or one specific HTTP method |
| **URL pattern** | which requests it applies to |
| **Status** | optional — report this HTTP status to the page instead of the real one |
| **Changes** | an ordered list of edits to the JSON body |

Rules apply in order, so a later rule can overwrite an earlier one.

### URL patterns

| Pattern | Matches |
| --- | --- |
| `*` or empty | every request |
| `/api/v1/users` | any URL containing that substring |
| `https://x.com/api/*` | glob — `*` is the only wildcard, and the pattern is anchored |
| `re:^https://api\.` | a JavaScript regular expression |

A pattern with no `*` is a substring match, so query strings are covered
automatically: `https://x.com/api/data` matches
`https://x.com/api/data?page=2&cachebust=0.1`.

### Field paths

| Path | Targets |
| --- | --- |
| `test` | a top-level field |
| `data.user.name` | a nested field |
| `items[0].id` / `items[-1]` | an array element (negative counts from the end) |
| `items[*].active` | every element of an array |
| `flags.*` | every key of an object |
| `["odd.key"].v` | a key containing a dot |
| *(empty)* | the whole response body |

Wildcards fan out over what already exists — they never create anything, so
`items[*].meta.enabled` silently skips elements with no `meta`.

### Change operations

| Op | Effect |
| --- | --- |
| **set** | write the value, creating missing parent objects/arrays along the way |
| **change existing** | write the value, but only if the field is really there — a path that matches nothing is an error, and the body is left untouched |
| **set if missing** | write only when the field is absent or `null` |
| **merge** | deep-merge an object into the field |
| **append to array** | push the value onto the array at that path |
| **remove** | delete the field (arrays are spliced, not left with holes) |

Values are JSON literals, entered as text: `true`, `42`, `"a string"` (quotes
included), `{"a": 1}`, `[]`, `null`. The editor flags anything that isn't valid
JSON.

`set` creates missing parents, which means a typo'd path still reports
`changed: 1` — it just writes to a branch nothing reads. Use **change existing**
while developing a rule and it will tell you how far the path actually got:

```
ERROR — path "user.add_expense.enabled" does not exist;
        deepest match was "user" — keys there: id, first_name, email, …
```

## Shipping your own defaults

`src/defaults.js` holds the rules a fresh install starts with. Anything there
with `enabled: true` is written to storage on install and is live immediately —
whoever installs it does not have to switch anything on.

Upgrades are keyed on each rule's `id`: when the extension updates, any default
whose `id` has never been seeded before is added, while rules the user has
edited or deleted are left alone. Give every new default a fresh, stable `id`
and never reuse one.

Editing `defaults.js` does **not** change rules already in storage. While
iterating, edit in the options page instead; to genuinely re-seed, run
`chrome.storage.local.clear()` in the service worker console and reload.

`op` in that file is the operation **id**, not the label from the dropdown:
`set`, `replace`, `default`, `merge`, `push`, `remove`.

## Debugging

The interceptor exposes `window.__RSPX__` in the page console — the page whose
requests you care about, not the DevTools console of another tab:

```js
__RSPX__.status        // is it installed? did the rules arrive? how many?
__RSPX__.recent        // every request seen, with why each was or wasn't rewritten
__RSPX__.hits          // only the ones a rule actually changed
__RSPX__.errors        // rules that matched but failed
__RSPX__.match(url)    // which rules would match this URL?
__RSPX__.verbose()     // log each interception as it happens
```

`recent` is the useful one: every entry carries an `outcome` explaining itself —
`REWRITTEN`, `no rule matched this URL`, `skipped — content-type is "text/html",
not JSON`, `skipped — interception is paused`, `ERROR — path ... does not
exist`. If a request you expected isn't listed at all, the page never made it
through `fetch`/`XHR`: it may be server-rendered into the HTML, or issued from a
Web Worker, which content scripts cannot reach.

The **DevTools Network tab shows the original response**, not the rewritten one
— it reads the bytes off the wire, below the layer being patched.

### "The rule fired, but the app behaves exactly the same"

`outcome: REWRITTEN` only proves the page *received* a modified body. Whether
that changes anything is a separate question:

1. **The same check exists on the server.** Rewriting a response changes what
   the client believes, never what the server does — it still sees the real
   request and answers on its own terms. Anything a backend independently
   enforces cannot be moved from here. By far the most common cause, and no
   amount of rule-tuning fixes it.
2. **You created a field instead of changing one.** Switch the op to **change
   existing**; the error names the deepest path that did exist and the keys
   available there.
3. **The UI never read that response** — state embedded in the HTML at load
   time, or a different endpoint entirely.
4. **Something cached the old value** in localStorage, IndexedDB or a service
   worker.
5. **The component already rendered** and nothing tells it to re-render.
6. **The payload is signed or checksummed** and the client rejects a body whose
   hash no longer matches.

Cause 1 is the ceiling on this whole approach: the tool edits the client's view
of a conversation, and any decision the server makes for itself stays out of
reach.

## How it works

MV3 gives extensions no way to rewrite a response body — `declarativeNetRequest`
can only block and redirect, and `webRequest` never sees bodies. So instead of
touching the network layer, the extension patches the page's own networking
primitives before any page script runs:

```
src/interceptor.js   MAIN world, document_start — patches window.fetch and
                     XMLHttpRequest.prototype's response accessors
src/bridge.js        ISOLATED world — the only part with chrome.* access; ships
                     rules into the page and forwards hit reports to the worker
src/engine.js        matching + JSON mutation; shared by the interceptor and the
                     options-page tester so both behave identically
src/background.js    seeds defaults, keeps the per-tab badge count
```

`fetch` is wrapped so the returned `Response` is rebuilt with the modified body
(`url`, `type`, `redirected` and headers are carried over; the stale
`content-length` is dropped). For XHR, rather than racing the page for the
`load` event, the `responseText` / `response` / `status` accessors themselves
are patched — so it works no matter how the page registered its handlers.

### Limits

- **Only the page's own `fetch`/`XHR` JSON responses are affected.** Navigations,
  documents, images, CSS, `EventSource` and WebSockets are not, and neither are
  requests made from inside a Web Worker or Service Worker.
- **The request still really happens.** The server receives the genuine request
  and sends a genuine response; only what the page *sees* is changed. This is a
  development and testing tool, not a way to change server state.
- **The page is not sandboxed from this.** A page determined to detect or undo
  the patch can do so, and a hostile page can forge the config event. Fine for
  development; don't treat it as a security boundary.
- Rules reach the page a moment after `document_start`. `fetch` waits for them
  (up to 2s); a response that somehow arrives before then passes through
  untouched rather than blocking the page.

## Development

```bash
npm test          # 84 tests
npm run package   # -> dist/free-expense-<version>.zip
npm run icons     # regenerate icons/ from tools/make_icons.py
```

`test_engine.js` covers pattern matching and every mutation operation.
`test_interceptor.js` builds a miniature MAIN world in a `vm` context — a fake
`window`, Node's `fetch`/`Response`, and an `XMLHttpRequest` stand-in with the
real accessor shape — then loads the actual `engine.js` and `interceptor.js`
into it and exercises both interception paths end to end.

`Alt+Shift+R` (Option+Shift+R on macOS) reloads the extension from disk and
refreshes the current tab in one keystroke.

### Releasing

Bump `version` in `manifest.json`, run `npm test` and `npm run package`, then
attach the zip to a GitHub Release. The zip contains only `manifest.json`,
`icons/`, `src/` and the README.
