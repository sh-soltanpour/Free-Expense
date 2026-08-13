/*
 * Integration tests for interceptor.js. Run with:  node tools/test_interceptor.js
 *
 * The interceptor is written against a browser MAIN world, so this builds a
 * miniature one in a vm context: a window that is also an EventTarget, Node's
 * native fetch/Response/Headers, and a fake XMLHttpRequest whose prototype
 * accessors behave like the real ones. Then it runs engine.js + interceptor.js
 * inside it, exactly as the manifest does.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

// ------------------------------------------------------- the fake MAIN world

/* Stands in for XMLHttpRequest: same accessor shape, driven manually. */
function makeFakeXHR() {
  class FakeXHR extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.responseType = '';
      this._body = '';
      this._status = 0;
    }

    open(method, url) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
    }

    send() {}

    /* Test helper: pretend the response arrived. */
    _complete(body, status = 200) {
      this._body = body;
      this._status = status;
      this.readyState = 4;
      // Real event order: the page's own load handler runs before loadend.
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    }
  }

  Object.defineProperty(FakeXHR.prototype, 'responseText', {
    configurable: true,
    get() {
      if (this.responseType !== '' && this.responseType !== 'text') {
        throw new Error('InvalidStateError');
      }
      return this._body;
    },
  });

  Object.defineProperty(FakeXHR.prototype, 'response', {
    configurable: true,
    get() {
      if (this.responseType === 'json') {
        // The real thing parses once and caches; mirror that.
        if (!this._parsed) this._parsed = JSON.parse(this._body);
        return this._parsed;
      }
      return this._body;
    },
  });

  Object.defineProperty(FakeXHR.prototype, 'status', {
    configurable: true,
    get() { return this._status; },
  });

  return FakeXHR;
}

function createWorld(networkResponder) {
  const bus = new EventTarget();
  const sandbox = {};

  const nativeFetch = async (input, init) => networkResponder(input, init);

  Object.assign(sandbox, {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    Response,
    Headers,
    Request,
    CustomEvent,
    Event,
    JSON,
    Object,
    Array,
    Error,
    fetch: nativeFetch,
    XMLHttpRequest: makeFakeXHR(),
    location: { href: 'https://page.test/index.html' },
    document: { baseURI: 'https://page.test/index.html' },
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus),
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  for (const file of ['engine.js', 'interceptor.js']) {
    new vm.Script(fs.readFileSync(path.join(SRC, file), 'utf8'), { filename: file }).runInContext(context);
  }

  /* What bridge.js does. */
  const configure = (config) => {
    sandbox.dispatchEvent(new CustomEvent('rspx:config', { detail: JSON.stringify(config) }));
  };

  const hits = [];
  sandbox.addEventListener('rspx:hit', (event) => hits.push(JSON.parse(event.detail)));

  return { window: sandbox, configure, hits };
}

const rule = (overrides) => ({
  id: 'r', name: 'test rule', enabled: true, method: 'ANY', url: '*', status: '', mutations: [], ...overrides,
});
const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { 'content-type': 'application/json', 'content-length': '123', ...(init.headers || {}) },
});

// ------------------------------------------------------------- fetch tests

async function main() {
  await test('fetch: rewrites a matching JSON body', async () => {
    const world = createWorld(() => jsonResponse({ test: false, keep: 'me' }));
    world.configure({
      enabled: true,
      rules: [rule({ url: 'https://api.test/*', mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const res = await world.window.fetch('https://api.test/thing');
    assert.deepEqual(await res.json(), { test: true, keep: 'me' });
    assert.equal(world.hits.length, 1);
    assert.equal(world.hits[0].count, 1);
  });

  await test('fetch: leaves non-matching URLs alone', async () => {
    const world = createWorld(() => jsonResponse({ test: false }));
    world.configure({
      enabled: true,
      rules: [rule({ url: 'https://api.test/*', mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const res = await world.window.fetch('https://other.test/thing');
    assert.deepEqual(await res.json(), { test: false });
    assert.equal(world.hits.length, 0);
  });

  await test('fetch: the master switch stops everything', async () => {
    const world = createWorld(() => jsonResponse({ test: false }));
    world.configure({
      enabled: false,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    assert.deepEqual(await (await world.window.fetch('https://api.test/x')).json(), { test: false });
  });

  await test('fetch: relative URLs are resolved against the page', async () => {
    const world = createWorld(() => jsonResponse({ test: false }));
    world.configure({
      enabled: true,
      rules: [rule({ url: 'https://page.test/api/*', mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    assert.deepEqual(await (await world.window.fetch('/api/x')).json(), { test: true });
  });

  await test('fetch: method filtering uses the init override', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    world.configure({
      enabled: true,
      rules: [rule({ method: 'POST', mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    assert.deepEqual(await (await world.window.fetch('https://a.test/x')).json(), { v: 0 });
    assert.deepEqual(await (await world.window.fetch('https://a.test/x', { method: 'POST' })).json(), { v: 1 });
  });

  await test('fetch: a Request object is read without consuming it', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    world.configure({
      enabled: true,
      rules: [rule({ method: 'PUT', mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    const request = new Request('https://a.test/x', { method: 'PUT', body: 'payload' });
    assert.deepEqual(await (await world.window.fetch(request)).json(), { v: 1 });
    assert.equal(request.bodyUsed, false, 'the caller\'s Request must still be usable');
  });

  await test('fetch: response metadata survives the rebuild', async () => {
    const world = createWorld(() => {
      const res = jsonResponse({ v: 0 }, { headers: { 'x-custom': 'kept' } });
      Object.defineProperty(res, 'url', { value: 'https://api.test/final' });
      return res;
    });
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    const res = await world.window.fetch('https://api.test/x');
    assert.equal(res.url, 'https://api.test/final');
    assert.equal(res.headers.get('x-custom'), 'kept');
    assert.equal(res.headers.get('content-length'), null, 'stale content-length must be dropped');
    assert.equal(res.status, 200);
  });

  await test('fetch: status override is applied', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    world.configure({ enabled: true, rules: [rule({ status: '403' })] });

    assert.equal((await world.window.fetch('https://a.test/x')).status, 403);
  });

  await test('fetch: non-JSON bodies pass through untouched', async () => {
    const world = createWorld(() => new Response('<html>hi</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    assert.equal(await (await world.window.fetch('https://a.test/x')).text(), '<html>hi</html>');
  });

  await test('fetch: a JSON content-type carrying invalid JSON is left as-is', async () => {
    const world = createWorld(() => new Response('not json at all', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    assert.equal(await (await world.window.fetch('https://a.test/x')).text(), 'not json at all');
  });

  await test('fetch: 204 responses are not given a body', async () => {
    const world = createWorld(() => new Response(null, { status: 204 }));
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    const res = await world.window.fetch('https://a.test/x');
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  });

  await test('fetch: config arriving late still applies', async () => {
    const world = createWorld(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ v: 0 });
    });

    const pending = world.window.fetch('https://a.test/x'); // starts before any config
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    assert.deepEqual(await (await pending).json(), { v: 1 });
  });

  await test('fetch: a network rejection is not swallowed', async () => {
    const world = createWorld(() => Promise.reject(new TypeError('Failed to fetch')));
    world.configure({ enabled: true, rules: [rule()] });

    await assert.rejects(() => world.window.fetch('https://a.test/x'), /Failed to fetch/);
  });

  // ---------------------------------------------------------------- xhr tests

  function completedXhr(world, { url = 'https://api.test/x', method = 'GET', body, status = 200, responseType = '' }) {
    const xhr = new world.window.XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = responseType;
    xhr.send();
    xhr._complete(body, status);
    return xhr;
  }

  await test('xhr: responseText is rewritten', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ url: 'https://api.test/*', mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ test: false }) });
    assert.deepEqual(JSON.parse(xhr.responseText), { test: true });
    assert.equal(world.hits.length, 1);
  });

  await test('xhr: repeated reads are stable and reported once', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'push', path: 'items', value: '9' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ items: [1] }) });
    const first = xhr.responseText;
    const second = xhr.responseText;
    assert.equal(first, second, 'a second read must not apply the rules again');
    assert.deepEqual(JSON.parse(first).items, [1, 9]);
    assert.equal(world.hits.length, 1);
  });

  await test('xhr: a partial body mid-stream is never parsed', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const xhr = new world.window.XMLHttpRequest();
    xhr.open('GET', 'https://api.test/x');
    xhr.send();
    xhr._body = '{"test": fal';
    xhr.readyState = 3;
    assert.equal(xhr.responseText, '{"test": fal');

    xhr._complete('{"test": false}');
    assert.deepEqual(JSON.parse(xhr.responseText), { test: true });
  });

  await test('xhr: responseType "json" is rewritten without double-applying', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'push', path: 'items', value: '9' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ items: [1] }), responseType: 'json' });
    assert.deepEqual(xhr.response.items, [1, 9]);
    assert.deepEqual(xhr.response.items, [1, 9], 'second read must be identical');
  });

  await test('xhr: responseType "blob" is left alone', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ test: false }), responseType: 'blob' });
    assert.deepEqual(JSON.parse(xhr.response), { test: false });
  });

  await test('xhr: status override', async () => {
    const world = createWorld(() => {});
    world.configure({ enabled: true, rules: [rule({ status: '500' })] });

    assert.equal(completedXhr(world, { body: '{}' }).status, 500);
    assert.equal(new world.window.XMLHttpRequest().status, 0, 'an unsent request still reads 0');
  });

  await test('xhr: non-matching requests are untouched', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ url: 'https://api.test/*', mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });

    const xhr = completedXhr(world, { url: 'https://elsewhere.test/x', body: JSON.stringify({ test: false }) });
    assert.deepEqual(JSON.parse(xhr.responseText), { test: false });
  });

  await test('xhr: a rule change invalidates the cached match', async () => {
    const world = createWorld(() => {});
    world.configure({ enabled: true, rules: [] });

    const xhr = completedXhr(world, { body: JSON.stringify({ test: false }) });
    assert.deepEqual(JSON.parse(xhr.responseText), { test: false });

    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'test', value: 'true' }] })],
    });
    assert.deepEqual(JSON.parse(xhr.responseText), { test: true });
  });

  await test('xhr: reading responseText with a blob responseType still throws', async () => {
    const world = createWorld(() => {});
    world.configure({ enabled: true, rules: [rule()] });

    const xhr = completedXhr(world, { body: '{}', responseType: 'blob' });
    assert.throws(() => xhr.responseText, /InvalidStateError/);
  });

  await test('the engine global is cleaned up so the page never sees it', async () => {
    const world = createWorld(() => {});
    assert.equal(world.window.__RSPX_ENGINE__, undefined);
  });

  // ------------------------------------------------------------ diagnostics

  await test('__RSPX__ reports install and config state', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    assert.equal(world.window.__RSPX__.status.installed, true);
    assert.equal(world.window.__RSPX__.status.fetchPatched, true);
    assert.equal(world.window.__RSPX__.status.xhrPatched, true);
    assert.equal(world.window.__RSPX__.status.configReceived, false, 'no config yet');

    world.configure({ enabled: true, rules: [rule()] });
    const status = world.window.__RSPX__.status;
    assert.equal(status.configReceived, true);
    assert.equal(status.interceptionEnabled, true);
    assert.equal(status.ruleCount, 1);
  });

  await test('__RSPX__.recent logs a rewritten request', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    world.configure({
      enabled: true,
      rules: [rule({ name: 'my rule', mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    await world.window.fetch('https://api.test/thing');
    const [entry] = world.window.__RSPX__.recent;
    assert.equal(entry.outcome, 'REWRITTEN');
    assert.equal(entry.changed, 1);
    assert.deepEqual(entry.rules, ['my rule']);
    assert.equal(world.window.__RSPX__.hits.length, 1);
  });

  await test('__RSPX__.recent explains why a request was skipped', async () => {
    const world = createWorld(() => jsonResponse({ v: 0 }));
    world.configure({ enabled: true, rules: [rule({ url: 'https://api.test/*' })] });

    await world.window.fetch('https://elsewhere.test/x');
    assert.match(world.window.__RSPX__.recent[0].outcome, /no rule matched/);

    const html = createWorld(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    html.configure({ enabled: true, rules: [rule()] });
    await html.window.fetch('https://api.test/x');
    assert.match(html.window.__RSPX__.recent[0].outcome, /content-type/);

    const paused = createWorld(() => jsonResponse({ v: 0 }));
    paused.configure({ enabled: false, rules: [rule()] });
    await paused.window.fetch('https://api.test/x');
    assert.match(paused.window.__RSPX__.recent[0].outcome, /paused/);
  });

  await test('__RSPX__.recent logs XHR too, even when nothing matches', async () => {
    const world = createWorld(() => {});
    world.configure({ enabled: true, rules: [rule({ url: 'https://api.test/*' })] });

    completedXhr(world, { url: 'https://elsewhere.test/x', body: '{}' });
    const entry = world.window.__RSPX__.recent.at(-1);
    assert.equal(entry.kind, 'xhr');
    assert.match(entry.outcome, /no rule matched/);
  });

  await test('__RSPX__.recent upgrades an XHR entry once the page reads it', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ v: 0 }) });
    assert.match(world.window.__RSPX__.recent.at(-1).outcome, /awaiting read/);

    JSON.parse(xhr.responseText); // the page reads it
    const entry = world.window.__RSPX__.recent.at(-1);
    assert.equal(entry.outcome, 'REWRITTEN');
    assert.equal(entry.changed, 1);
  });

  await test('__RSPX__ logs a read that happens in the page\'s own load handler', async () => {
    // Regression: the log entry used to be created on loadend, which fires
    // *after* the page's load handler has already read the response — so a
    // rewritten request was reported as "matched — awaiting read", changed 0.
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'set', path: 'v', value: '1' }] })],
    });

    const xhr = new world.window.XMLHttpRequest();
    xhr.open('GET', 'https://api.test/x');

    let seenByPage = null;
    xhr.addEventListener('load', () => { seenByPage = JSON.parse(xhr.responseText); });

    xhr.send();
    xhr._complete(JSON.stringify({ v: 0 }));

    assert.deepEqual(seenByPage, { v: 1 }, 'the page must receive the rewritten body');

    const entry = world.window.__RSPX__.recent.at(-1);
    assert.equal(entry.outcome, 'REWRITTEN', 'and the log must say so');
    assert.equal(entry.changed, 1);
    assert.deepEqual(entry.rules, ['test rule']);
    assert.equal(world.window.__RSPX__.hits.length, 1);
  });

  await test('a matched request whose fields are already correct says so', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'default', path: 'v', value: '1' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ v: 0 }) });
    JSON.parse(xhr.responseText);
    assert.match(world.window.__RSPX__.recent.at(-1).outcome, /no field changed/);
  });

  await test('a replace against a missing path is reported as an ERROR, body untouched', async () => {
    const world = createWorld(() => jsonResponse({ user: { id: 7, name: 'x' } }));
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'replace', path: 'user.add_expense.enabled', value: 'true' }] })],
    });

    const res = await world.window.fetch('https://api.test/main');
    assert.deepEqual(await res.json(), { user: { id: 7, name: 'x' } }, 'body must pass through unchanged');

    const entry = world.window.__RSPX__.recent.at(-1);
    assert.match(entry.outcome, /^ERROR — /);
    assert.match(entry.outcome, /deepest match was "user"/);
    assert.equal(entry.changed, 0);
    assert.equal(world.window.__RSPX__.errors.length, 1);
    assert.equal(world.window.__RSPX__.hits.length, 0);
  });

  await test('a replace that lands is a normal rewrite', async () => {
    const world = createWorld(() => jsonResponse({ user: { add_expense: { enabled: false } } }));
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'replace', path: 'user.add_expense.enabled', value: 'true' }] })],
    });

    const res = await world.window.fetch('https://api.test/main');
    assert.deepEqual(await res.json(), { user: { add_expense: { enabled: true } } });
    assert.equal(world.window.__RSPX__.recent.at(-1).outcome, 'REWRITTEN');
    assert.equal(world.window.__RSPX__.errors.length, 0);
  });

  await test('XHR surfaces replace errors the same way', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ mutations: [{ enabled: true, op: 'replace', path: 'user.missing', value: 'true' }] })],
    });

    const xhr = completedXhr(world, { body: JSON.stringify({ user: { id: 1 } }) });
    assert.deepEqual(JSON.parse(xhr.responseText), { user: { id: 1 } });
    assert.match(world.window.__RSPX__.recent.at(-1).outcome, /^ERROR — /);
  });

  await test('__RSPX__.match answers "would this URL match?"', async () => {
    const world = createWorld(() => {});
    world.configure({
      enabled: true,
      rules: [rule({ name: 'splitwise', method: 'GET', url: 'https://secure.splitwise.com/api/v3.0/get_main_data' })],
    });

    assert.equal(world.window.__RSPX__.match('https://secure.splitwise.com/api/v3.0/get_main_data').length, 1);
    assert.equal(world.window.__RSPX__.match('https://secure.splitwise.com/api/v3.0/get_main_data?x=1').length, 1);
    assert.equal(world.window.__RSPX__.match('https://secure.splitwise.com/api/v3.0/get_main_data', 'POST').length, 0);
    assert.equal(world.window.__RSPX__.match('https://secure.splitwise.com/api/v3.0/other').length, 0);
  });

  for (const { name, err } of failures) {
    console.error(`FAIL  ${name}\n      ${err.message.split('\n').slice(0, 3).join('\n      ')}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main();
