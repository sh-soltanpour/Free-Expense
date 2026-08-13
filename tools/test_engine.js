/*
 * Engine tests. Run with:  node tools/test_engine.js
 * engine.js is browser-first but exports through module.exports for exactly this.
 */
const assert = require('node:assert');
const engine = require('../src/engine.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

const rule = (overrides) => ({
  id: 'r', name: 'r', enabled: true, method: 'ANY', url: '*', status: '', mutations: [], ...overrides,
});
const mut = (op, path, value) => ({ enabled: true, op, path, value });

// ------------------------------------------------------------ url patterns

test('empty and * match everything', () => {
  assert.ok(engine.urlMatches('', 'https://a.test/x'));
  assert.ok(engine.urlMatches('*', 'https://a.test/x'));
});

test('substring matching', () => {
  assert.ok(engine.urlMatches('/api/v1/users', 'https://a.test/api/v1/users?page=2'));
  assert.ok(!engine.urlMatches('/api/v2/users', 'https://a.test/api/v1/users'));
});

test('glob is anchored', () => {
  assert.ok(engine.urlMatches('https://a.test/api/*', 'https://a.test/api/users'));
  assert.ok(!engine.urlMatches('https://a.test/api/*', 'https://b.test/api/users'));
  assert.ok(engine.urlMatches('*://a.test/*', 'https://a.test/x/y'));
});

test('glob escapes regex metacharacters', () => {
  assert.ok(!engine.urlMatches('https://a.test/x', 'https://aXtest/x'));
});

test('re: prefix compiles a regex, and a path-like pattern is not mistaken for one', () => {
  assert.ok(engine.urlMatches('re:^https://api\\.', 'https://api.example.com/v1'));
  assert.ok(engine.urlMatches('/api/users', 'https://a.test/api/users'));
});

test('an invalid regex matches nothing rather than throwing', () => {
  assert.equal(engine.compilePattern('re:[unclosed').kind, 'never');
  assert.ok(!engine.urlMatches('re:[unclosed', 'anything'));
});

test('method matching', () => {
  assert.ok(engine.methodMatches('ANY', 'POST'));
  assert.ok(engine.methodMatches('post', 'POST'));
  assert.ok(!engine.methodMatches('GET', 'POST'));
});

test('disabled rules never match', () => {
  const matched = engine.matchRules([rule({ enabled: false })], { url: 'x', method: 'GET' });
  assert.equal(matched.length, 0);
});

// -------------------------------------------------------------- path parser

test('path tokenising', () => {
  assert.deepEqual(engine.parsePath('test'), ['test']);
  assert.deepEqual(engine.parsePath('data.user.name'), ['data', 'user', 'name']);
  assert.deepEqual(engine.parsePath('items[0].id'), ['items', '0', 'id']);
  assert.deepEqual(engine.parsePath('items[*].active'), ['items', '*', 'active']);
  assert.deepEqual(engine.parsePath('["odd.key"].v'), ['odd.key', 'v']);
  assert.deepEqual(engine.parsePath('$.a'), ['a']);
  assert.deepEqual(engine.parsePath(''), []);
});

// --------------------------------------------------------------- mutations

function run(mutations, data) {
  return engine.applyRules([rule({ mutations })], data);
}

test('the headline case: force test to true', () => {
  const out = run([mut('set', 'test', 'true')], { test: false });
  assert.deepEqual(out.data, { test: true });
  assert.equal(out.count, 1);
});

test('set creates missing parents', () => {
  const out = run([mut('set', 'a.b.c', '"hi"')], {});
  assert.deepEqual(out.data, { a: { b: { c: 'hi' } } });
});

test('set creates an array when the next token is numeric', () => {
  const out = run([mut('set', 'list[1]', '9')], {});
  assert.ok(Array.isArray(out.data.list));
  assert.equal(out.data.list[1], 9);
});

test('wildcard over an array', () => {
  const out = run([mut('set', 'items[*].active', 'true')], {
    items: [{ active: false }, { active: false }],
  });
  assert.deepEqual(out.data.items, [{ active: true }, { active: true }]);
  assert.equal(out.count, 2);
});

test('wildcard over object keys', () => {
  const out = run([mut('set', 'flags.*', 'true')], { flags: { a: false, b: false } });
  assert.deepEqual(out.data.flags, { a: true, b: true });
});

test('negative array index', () => {
  const out = run([mut('set', 'items[-1]', '"last"')], { items: [1, 2, 3] });
  assert.deepEqual(out.data.items, [1, 2, 'last']);
});

test('wildcard set does not invent missing fields', () => {
  const out = run([mut('set', 'items[*].nope.deep', 'true')], { items: [{}, {}] });
  assert.equal(out.count, 0);
});

test('default only fills absent or null fields', () => {
  const out = run([mut('default', 'a', '"filled"'), mut('default', 'b', '"filled"'), mut('default', 'c', '"filled"')],
    { a: 'kept', b: null });
  assert.deepEqual(out.data, { a: 'kept', b: 'filled', c: 'filled' });
});

test('merge is deep and non-destructive', () => {
  const out = run([mut('merge', 'account', '{"plan":"pro","limits":{"seats":10}}')],
    { account: { id: 7, limits: { seats: 1, files: 5 } } });
  assert.deepEqual(out.data.account, { id: 7, plan: 'pro', limits: { seats: 10, files: 5 } });
});

test('merge into a missing field creates it', () => {
  const out = run([mut('merge', 'meta', '{"a":1}')], {});
  assert.deepEqual(out.data.meta, { a: 1 });
});

test('push appends, and creates the array when absent', () => {
  const out = run([mut('push', 'items', '{"id":3}'), mut('push', 'fresh', '1')], { items: [{ id: 1 }] });
  assert.deepEqual(out.data.items, [{ id: 1 }, { id: 3 }]);
  assert.deepEqual(out.data.fresh, [1]);
});

test('remove deletes an object key', () => {
  const out = run([mut('remove', 'secret', '')], { secret: 1, keep: 2 });
  assert.deepEqual(out.data, { keep: 2 });
});

test('remove over a wildcard splices every element without index drift', () => {
  const out = run([mut('remove', 'items[*]', '')], { items: [1, 2, 3, 4] });
  assert.deepEqual(out.data.items, []);
  assert.equal(out.count, 4);
});

test('remove a single array index', () => {
  const out = run([mut('remove', 'items[1]', '')], { items: ['a', 'b', 'c'] });
  assert.deepEqual(out.data.items, ['a', 'c']);
});

test('an empty path addresses the whole body', () => {
  assert.deepEqual(run([mut('set', '', '{"replaced":true}')], { old: 1 }).data, { replaced: true });
  assert.deepEqual(run([mut('merge', '', '{"b":2}')], { a: 1 }).data, { a: 1, b: 2 });
});

test('rules apply in order, later ones winning', () => {
  const out = engine.applyRules(
    [rule({ mutations: [mut('set', 'v', '1')] }), rule({ mutations: [mut('set', 'v', '2')] })],
    {},
  );
  assert.equal(out.data.v, 2);
});

test('disabled mutations are skipped', () => {
  const out = run([{ enabled: false, op: 'set', path: 'v', value: '1' }], {});
  assert.deepEqual(out.data, {});
});

test('invalid JSON values are reported, not thrown', () => {
  const out = run([mut('set', 'v', '{oops'), mut('set', 'ok', 'true')], {});
  assert.equal(out.errors.length, 1);
  assert.equal(out.data.ok, true, 'later mutations still run');
});

test('the injected value is cloned, so rules cannot share mutable state', () => {
  const out = run([mut('set', 'a', '{"n":1}'), mut('set', 'b', '{"n":1}')], {});
  out.data.a.n = 99;
  assert.equal(out.data.b.n, 1);
});

test('a primitive body survives a nested path untouched', () => {
  assert.equal(run([mut('set', 'a.b', '1')], 5).data, 5);
});

test('arrays at the root work', () => {
  const out = run([mut('set', '[*].ok', 'true')], [{ ok: false }, { ok: false }]);
  assert.deepEqual(out.data, [{ ok: true }, { ok: true }]);
});

test('non-numeric token against an array is a no-op', () => {
  const out = run([mut('set', 'items.name', '"x"')], { items: [1, 2] });
  assert.equal(out.count, 0);
});

// ------------------------------------------------------- replace (strict set)

test('replace changes a field that exists', () => {
  const out = run([mut('replace', 'user.add_expense.enabled', 'true')],
    { user: { add_expense: { enabled: false, reason: 'limit' } } });
  assert.deepEqual(out.data.user.add_expense, { enabled: true, reason: 'limit' });
  assert.equal(out.errors.length, 0);
});

test('replace errors instead of creating a missing leaf', () => {
  const out = run([mut('replace', 'user.add_expense.enabled', 'true')], { user: { id: 7, name: 'x' } });
  assert.equal(out.count, 0);
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.data, { user: { id: 7, name: 'x' } }, 'the body must be left alone');
});

test('the error names the deepest existing path and what was there', () => {
  const out = run([mut('replace', 'user.add_expense.enabled', 'true')], { user: { id: 7, name: 'x' } });
  const message = out.errors[0].error;
  assert.match(message, /does not exist/);
  assert.match(message, /deepest match was "user"/);
  assert.match(message, /keys there: id, name/);
});

test('the error points at the root when nothing matches at all', () => {
  const out = run([mut('replace', 'nope.deep', 'true')], { a: 1, b: 2 });
  assert.match(out.errors[0].error, /deepest match was the root/);
  assert.match(out.errors[0].error, /keys there: a, b/);
});

test('replace reports arrays and primitives usefully', () => {
  assert.match(run([mut('replace', 'items.name', '1')], { items: [1, 2, 3] }).errors[0].error, /an array of 3/);
  assert.match(run([mut('replace', 'a.b', '1')], { a: 'text' }).errors[0].error, /a string/);
  assert.match(run([mut('replace', 'a.b', '1')], { a: {} }).errors[0].error, /an empty object/);
});

test('replace long key lists are truncated', () => {
  const wide = {};
  for (let i = 0; i < 20; i += 1) wide['k' + i] = i;
  assert.match(run([mut('replace', 'missing.x', '1')], wide).errors[0].error, /, …$/);
});

test('replace never creates, even for a top-level field', () => {
  const out = run([mut('replace', 'brandNew', 'true')], { existing: 1 });
  assert.deepEqual(out.data, { existing: 1 });
  assert.equal(out.errors.length, 1);
});

test('replace handles a field that exists but is null or false', () => {
  const out = run([mut('replace', 'a', '"set"'), mut('replace', 'b', '"set"')], { a: null, b: false });
  assert.deepEqual(out.data, { a: 'set', b: 'set' });
  assert.equal(out.errors.length, 0);
});

test('replace fans out over wildcards, counting only what existed', () => {
  const out = run([mut('replace', 'items[*].active', 'true')],
    { items: [{ active: false }, { active: false }, { other: 1 }] });
  assert.deepEqual(out.data.items, [{ active: true }, { active: true }, { other: 1 }]);
  assert.equal(out.count, 2);
  assert.equal(out.errors.length, 0);
});

test('a wildcard matching nothing is still an error', () => {
  const out = run([mut('replace', 'items[*].active', 'true')], { items: [{ other: 1 }] });
  assert.equal(out.count, 0);
  assert.equal(out.errors.length, 1);
});

test('replace works through array indices', () => {
  const out = run([mut('replace', 'items[1].id', '99')], { items: [{ id: 1 }, { id: 2 }] });
  assert.deepEqual(out.data.items, [{ id: 1 }, { id: 99 }]);
  assert.match(run([mut('replace', 'items[5].id', '99')], { items: [{ id: 1 }] }).errors[0].error, /does not exist/);
});

test('a failed replace does not stop later mutations', () => {
  const out = run([mut('replace', 'missing', 'true'), mut('set', 'ok', 'true')], {});
  assert.equal(out.errors.length, 1);
  assert.equal(out.data.ok, true);
});

test('replace on a non-object body errors rather than silently passing', () => {
  const out = run([mut('replace', 'a', '1')], 5);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /not an object or array/);
});

test('an empty path replaces the whole body', () => {
  assert.deepEqual(run([mut('replace', '', '{"all":"new"}')], { old: 1 }).data, { all: 'new' });
});

test('set still creates, so the two ops stay distinguishable', () => {
  assert.deepEqual(run([mut('set', 'a.b', 'true')], {}).data, { a: { b: true } });
  assert.equal(run([mut('replace', 'a.b', 'true')], {}).errors.length, 1);
});

test('an unknown op is an error, not a silent no-op', () => {
  // Regression: a hand-edited rule using the dropdown label instead of the id.
  const out = run([mut('change existing', 'a', 'true')], { a: false });
  assert.equal(out.count, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /unknown operation "change existing"/);
  assert.match(out.errors[0].error, /set, replace, default, merge, push, remove/);
});

test('every shipped default rule uses a real op', () => {
  const ids = new Set(engine.OPERATIONS.map((o) => o.id));
  const source = require('node:fs').readFileSync(__dirname + '/../src/defaults.js', 'utf8');
  for (const [, op] of source.matchAll(/\bop:\s*'([^']+)'/g)) {
    assert.ok(ids.has(op), `defaults.js uses unknown op "${op}"`);
  }
});

// ----------------------------------------------------------------- statuses

test('status override picks the last valid one', () => {
  assert.equal(engine.statusOverride([rule({ status: '200' }), rule({ status: '404' })]), 404);
  assert.equal(engine.statusOverride([rule({ status: '' })]), null);
  assert.equal(engine.statusOverride([rule({ status: '999' })]), null);
});

// ------------------------------------------------------------ content types

test('content-type sniffing', () => {
  assert.ok(engine.looksLikeJson('application/json; charset=utf-8'));
  assert.ok(engine.looksLikeJson(null), 'a missing content-type is worth a parse attempt');
  assert.ok(!engine.looksLikeJson('text/html'));
  assert.ok(!engine.looksLikeJson('image/png'));
});

// -------------------------------------------------------------------- report

for (const { name, err } of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
