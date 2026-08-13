/*
 * interceptor.js — runs in the page's MAIN world at document_start.
 *
 * MV3 gives extensions no way to rewrite a response body (declarativeNetRequest
 * can only redirect/block, and webRequest cannot see bodies), so the only real
 * option is to patch the page's own networking primitives before any page code
 * runs. That is what this file does, for fetch() and XMLHttpRequest.
 *
 * It has no access to chrome.* — bridge.js (ISOLATED world) ships the rules
 * over as CustomEvents carrying JSON strings.
 *
 * Debugging: window.__RSPX__ in the page console reports what this file saw.
 */
(function () {
  'use strict';

  const engine = window.__RSPX_ENGINE__;
  try { delete window.__RSPX_ENGINE__; } catch (e) { /* non-configurable, ignore */ }
  if (!engine) return;

  const CONFIG_EVENT = 'rspx:config';
  const HIT_EVENT = 'rspx:hit';
  const RECENT_LIMIT = 300;

  // ------------------------------------------------------------ rule config

  let config = { enabled: false, rules: [] };
  let configVersion = 0;
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  window.addEventListener(CONFIG_EVENT, (event) => {
    try {
      const next = JSON.parse(event.detail);
      config = { enabled: next.enabled !== false, rules: next.rules || [] };
      configVersion += 1;
      ready = true;
      resolveReady();
    } catch (err) { /* malformed payload, keep the previous config */ }
  });

  /*
   * The rules arrive asynchronously (a storage read kicked off at
   * document_start), so a response could in principle land before they do.
   * fetch() is async anyway, so we can simply wait — with a ceiling, so a
   * broken bridge degrades to "extension does nothing" instead of hanging
   * every request on the page.
   */
  function whenReady() {
    if (ready) return null;
    return Promise.race([
      readyPromise,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }

  // -------------------------------------------------------------- diagnostics

  const recent = [];
  let verbose = false;

  /* Every observed request lands here, matched or not — this is what makes
     "why didn't my rule fire?" answerable without guesswork. */
  function record(ctx, kind, outcome, matched) {
    const entry = {
      time: new Date().toISOString().slice(11, 23),
      method: ctx.method,
      url: ctx.url,
      kind,
      outcome,
      rules: matched ? matched.map((r) => r.name || r.id) : [],
      changed: 0,
      errors: [],
    };
    recent.push(entry);
    if (recent.length > RECENT_LIMIT) recent.shift();
    if (verbose) console.log('[Free Expense]', outcome, ctx.method, ctx.url, entry.rules);
    return entry;
  }

  function skipReason() {
    if (!ready) return 'skipped — rules never arrived from the extension';
    if (!config.enabled) return 'skipped — interception is paused';
    return null;
  }

  Object.defineProperty(window, '__RSPX__', {
    configurable: true,
    enumerable: false,
    value: {
      get status() {
        return {
          installed: true,
          fetchPatched: window.fetch !== nativeFetch,
          xhrPatched: patchedXHR,
          configReceived: ready,
          interceptionEnabled: config.enabled,
          ruleCount: config.rules.length,
          configVersion,
        };
      },
      get rules() { return config.rules; },
      /* Everything this page has requested, newest last. */
      get recent() { return recent.slice(); },
      /* Only the requests a rule actually fired on. */
      get hits() { return recent.filter((e) => e.changed > 0); },
      /* Rules that matched but failed — usually a path that does not exist. */
      get errors() { return recent.filter((e) => e.errors.length); },
      /* Which of your rules would match a given URL? */
      match(url, method = 'GET') {
        const ctx = { url: String(url), method: String(method).toUpperCase() };
        return engine.matchRules(config.rules, ctx).map((r) => ({ name: r.name, url: r.url, method: r.method }));
      },
      /* Log every intercepted request as it happens. */
      verbose(on = true) { verbose = on; return `verbose logging ${on ? 'on' : 'off'}`; },
      clear() { recent.length = 0; },
    },
  });

  function report(ctx, matched, kind, count) {
    try {
      window.dispatchEvent(new CustomEvent(HIT_EVENT, {
        detail: JSON.stringify({
          url: ctx.url,
          method: ctx.method,
          kind,
          count,
          rules: matched.map((r) => r.name || r.id),
        }),
      }));
    } catch (err) { /* reporting is best-effort */ }
  }

  function absoluteUrl(url) {
    try { return new URL(String(url), document.baseURI || location.href).href; }
    catch (err) { return String(url); }
  }

  /* Returns { text, count, errors } or null when the body was not JSON. */
  function transform(matched, text, ctx, kind) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return null;
    }

    const result = engine.applyRules(matched, data);
    for (const problem of result.errors) {
      console.error('[Free Expense] rule "%s": %s', problem.rule, problem.error, '\n' + ctx.url);
    }
    if (result.count) report(ctx, matched, kind, result.count);
    return { text: JSON.stringify(result.data), count: result.count, errors: result.errors };
  }

  /* One place deciding what a finished interception is called in the log. */
  function applyOutcome(entry, result, matched) {
    if (!entry) return;
    entry.changed = result.count;
    entry.rules = matched.map((r) => r.name || r.id);
    entry.errors = result.errors.map((e) => e.error);
    if (result.errors.length) {
      entry.outcome = 'ERROR — ' + result.errors[0].error;
    } else {
      entry.outcome = result.count > 0 ? 'REWRITTEN' : 'matched — but no field changed';
    }
  }

  // ------------------------------------------------------------------ fetch

  const nativeFetch = window.fetch;

  if (typeof nativeFetch === 'function') {
    const patchedFetch = function fetch(input, init) {
      let ctx;
      try {
        let url;
        let method;
        if (typeof input === 'string') {
          url = input;
        } else if (input instanceof URL) {
          url = input.href;
        } else if (input && typeof input === 'object') {
          // A Request object. Read its fields without constructing a new
          // Request, which would mark the original's body as used.
          url = input.url;
          method = input.method;
        }
        if (init && init.method) method = init.method;
        ctx = { url: absoluteUrl(url), method: String(method || 'GET').toUpperCase() };
      } catch (err) {
        ctx = null;
      }

      const pending = nativeFetch.apply(this, arguments);
      if (!ctx) return pending;
      return pending.then((response) => handleResponse(response, ctx));
    };

    // Sites occasionally sniff for a native fetch; make the disguise cheap.
    try {
      Object.defineProperty(patchedFetch, 'toString', {
        value: () => 'function fetch() { [native code] }',
        configurable: true,
        writable: true,
      });
    } catch (err) { /* ignore */ }

    window.fetch = patchedFetch;
  }

  async function handleResponse(response, ctx) {
    try {
      if (!response || typeof response.clone !== 'function') return response;

      if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error') {
        record(ctx, 'fetch', `skipped — ${response.type} response has no readable body`);
        return response;
      }
      if (response.status === 0 || response.status === 204 || response.status === 205 || response.status === 304) {
        record(ctx, 'fetch', `skipped — status ${response.status} carries no body`);
        return response;
      }
      if (!response.body) {
        record(ctx, 'fetch', 'skipped — empty body');
        return response;
      }

      const wait = whenReady();
      if (wait) await wait;

      const skip = skipReason();
      if (skip) {
        record(ctx, 'fetch', skip);
        return response;
      }

      const matched = engine.matchRules(config.rules, ctx);
      if (!matched.length) {
        record(ctx, 'fetch', 'no rule matched this URL');
        return response;
      }

      const contentType = response.headers.get('content-type');
      if (!engine.looksLikeJson(contentType)) {
        record(ctx, 'fetch', `skipped — content-type is "${contentType}", not JSON`, matched);
        return response;
      }

      const text = await response.text();
      const result = transform(matched, text, ctx, 'fetch');
      const status = engine.statusOverride(matched);

      if (result === null) {
        record(ctx, 'fetch', 'skipped — body did not parse as JSON', matched);
        return rebuild(response, text, status);
      }

      applyOutcome(record(ctx, 'fetch', 'pending', matched), result, matched);
      return rebuild(response, result.text, status);
    } catch (err) {
      console.warn('[Free Expense] fetch interception failed:', err);
      record(ctx, 'fetch', 'error — ' + err.message);
      return response;
    }
  }

  /*
   * Response is immutable, so a modified body means a brand new Response.
   * url / redirected / type are not settable through the constructor, so they
   * are re-pinned afterwards to keep the object indistinguishable to callers.
   */
  function rebuild(original, body, statusOverride) {
    const status = statusOverride || original.status;
    if (status < 200 || status > 599) return new Response(body);

    const headers = new Headers(original.headers);
    headers.delete('content-length'); // the length just changed

    const replacement = new Response(body, {
      status,
      statusText: original.statusText,
      headers,
    });

    for (const prop of ['url', 'redirected', 'type']) {
      try {
        Object.defineProperty(replacement, prop, { value: original[prop] });
      } catch (err) { /* ignore */ }
    }
    return replacement;
  }

  // --------------------------------------------------------- XMLHttpRequest

  const XHR = window.XMLHttpRequest;
  let patchedXHR = false;

  if (XHR && XHR.prototype) {
    const proto = XHR.prototype;
    const state = new WeakMap();

    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const describe = (prop) => Object.getOwnPropertyDescriptor(proto, prop);
    const nativeResponseText = describe('responseText');
    const nativeResponse = describe('response');
    const nativeStatus = describe('status');

    proto.open = function open(method, url) {
      try {
        state.set(this, {
          method: String(method || 'GET').toUpperCase(),
          url: absoluteUrl(url),
        });
      } catch (err) { /* ignore */ }
      return nativeOpen.apply(this, arguments);
    };

    /*
     * Logging only — the rewrite itself happens in the accessors below.
     *
     * The entry is created here rather than on loadend because the page
     * typically reads the response inside its own load/readystatechange
     * handler, which runs *before* our loadend listener. Creating it late
     * meant the read had nowhere to record itself and every entry looked
     * untouched.
     */
    const PENDING = 'pending — request in flight';

    proto.send = function send() {
      const meta = state.get(this);
      if (meta) {
        try {
          meta.entry = record({ url: meta.url, method: meta.method }, 'xhr', PENDING);
          this.addEventListener('loadend', () => {
            // Only fill in an outcome if a read hasn't already claimed one.
            if (!meta.entry || meta.entry.outcome !== PENDING) return;
            const skip = skipReason();
            if (skip) { meta.entry.outcome = skip; return; }
            const matched = matchedFor(this);
            if (matched) {
              meta.entry.outcome = 'matched — awaiting read';
              meta.entry.rules = matched.map((r) => r.name || r.id);
            } else {
              meta.entry.outcome = 'no rule matched this URL';
            }
          });
        } catch (err) { /* ignore */ }
      }
      return nativeSend.apply(this, arguments);
    };

    /*
     * Rather than racing the page for the load event, the response accessors
     * themselves are patched: whatever the page reads, it reads through us, no
     * matter how it registered its handlers. Results are memoised per request
     * so repeated reads stay cheap and stable.
     */
    function matchedFor(xhr) {
      const meta = state.get(xhr);
      if (!meta || !ready || !config.enabled) return null;
      if (meta.version !== configVersion) {
        meta.version = configVersion;
        meta.matched = engine.matchRules(config.rules, meta);
        meta.cache = null;
      }
      return meta.matched.length ? meta.matched : null;
    }

    function rewriteText(xhr, raw) {
      if (typeof raw !== 'string' || raw === '') return raw;
      if (xhr.readyState !== 4) return raw; // don't parse a partial body
      const matched = matchedFor(xhr);
      if (!matched) return raw;

      const meta = state.get(xhr);
      if (meta.cache && meta.cache.input === raw) return meta.cache.output;

      const ctx = { url: meta.url, method: meta.method };
      const result = transform(matched, raw, ctx, 'xhr');
      const output = result === null ? raw : result.text;
      if (result === null) {
        if (meta.entry) meta.entry.outcome = 'skipped — body did not parse as JSON';
      } else {
        applyOutcome(meta.entry, result, matched);
      }
      meta.cache = { input: raw, output };
      return output;
    }

    if (nativeResponseText && nativeResponseText.get) {
      Object.defineProperty(proto, 'responseText', {
        configurable: true,
        enumerable: nativeResponseText.enumerable,
        get: function () {
          const raw = nativeResponseText.get.call(this);
          try { return rewriteText(this, raw); }
          catch (err) { return raw; }
        },
      });
    }

    if (nativeResponse && nativeResponse.get) {
      Object.defineProperty(proto, 'response', {
        configurable: true,
        enumerable: nativeResponse.enumerable,
        get: function () {
          const raw = nativeResponse.get.call(this);
          try {
            const type = this.responseType;
            if (type === '' || type === 'text') return rewriteText(this, raw);
            if (type === 'json') return rewriteJson(this, raw);
            return raw; // blob / arraybuffer / document are left alone
          } catch (err) {
            return raw;
          }
        },
      });
    }

    function rewriteJson(xhr, raw) {
      if (raw === null || typeof raw !== 'object') return raw;
      if (xhr.readyState !== 4) return raw;
      const matched = matchedFor(xhr);
      if (!matched) return raw;

      const meta = state.get(xhr);
      if (meta.cache && meta.cache.input === raw) return meta.cache.output;

      // The native getter hands back a cached object; mutate a copy so a
      // second read doesn't apply the rules twice.
      const result = engine.applyRules(matched, JSON.parse(JSON.stringify(raw)));
      for (const problem of result.errors) {
        console.error('[Free Expense] rule "%s": %s', problem.rule, problem.error, '\n' + meta.url);
      }
      if (result.count) report({ url: meta.url, method: meta.method }, matched, 'xhr', result.count);
      applyOutcome(meta.entry, result, matched);
      meta.cache = { input: raw, output: result.data };
      return result.data;
    }

    if (nativeStatus && nativeStatus.get) {
      Object.defineProperty(proto, 'status', {
        configurable: true,
        enumerable: nativeStatus.enumerable,
        get: function () {
          const raw = nativeStatus.get.call(this);
          try {
            if (raw === 0 || this.readyState < 2) return raw;
            const matched = matchedFor(this);
            if (!matched) return raw;
            const override = engine.statusOverride(matched);
            return override === null ? raw : override;
          } catch (err) {
            return raw;
          }
        },
      });
    }

    patchedXHR = true;
  }
})();
