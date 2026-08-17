/*
 * Seeding tests. Run with:  node tools/test_seed.mjs
 *
 * Answers the question "is the extension actually on after someone installs
 * it?" without anyone having to install it.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSeed } from '../src/seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const rule = (id, overrides = {}) => ({
  id, name: id, enabled: true, method: 'ANY', url: '*', status: '', mutations: [], ...overrides,
});

const DEFAULTS = [rule('alpha'), rule('beta')];
const plan = (reason, stored) => planSeed({
  reason, stored, defaultRules: DEFAULTS, defaultEnabled: true,
});

// -------------------------------------------------------- the headline case

test('a fresh install turns interception on', () => {
  assert.equal(plan('install', {}).enabled, true);
});

test('a fresh install ships every default rule, all enabled', () => {
  const result = plan('install', {});
  assert.equal(result.rules.length, 2);
  for (const r of result.rules) assert.equal(r.enabled, true, `${r.id} must be on`);
});

test('a fresh install records what it seeded', () => {
  assert.deepEqual(plan('install', {}).seededIds, ['alpha', 'beta']);
});

test('a stale enabled:false does not survive a reinstall', () => {
  // Regression: this used to be preserved, so a reinstall could leave someone
  // with an extension that looked installed but silently did nothing.
  assert.equal(plan('install', { enabled: false }).enabled, true);
});

test('clearing storage re-seeds everything, switched on', () => {
  const result = plan('update', { seededIds: ['alpha', 'beta'] }); // rules wiped
  assert.equal(result.enabled, true);
  assert.equal(result.rules.length, 2);
});

test('the shipped defaults are themselves on', () => {
  // planSeed copies whatever defaults.js says, so assert on the file too.
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'defaults.js'), 'utf8');
  assert.match(source, /DEFAULT_ENABLED\s*=\s*true/, 'DEFAULT_ENABLED must be true');

  const flags = [...source.matchAll(/^\s{4}enabled:\s*(true|false),/gm)].map((m) => m[1]);
  assert.ok(flags.length > 0, 'expected at least one rule in defaults.js');
  for (const flag of flags) assert.equal(flag, 'true', 'every shipped rule must be enabled');
});

// ------------------------------------------------------------------ updates

test('an update leaves the master switch exactly as the user set it', () => {
  const stored = { rules: [rule('alpha')], enabled: false, seededIds: ['alpha', 'beta'] };
  assert.equal('enabled' in plan('update', stored), false, 'must not touch enabled');
});

test('an update leaves user rules alone', () => {
  const stored = {
    rules: [rule('alpha', { enabled: false, name: 'renamed' })],
    seededIds: ['alpha', 'beta'],
  };
  const result = plan('update', stored);
  assert.equal('rules' in result, false, 'nothing new to add, so rules untouched');
});

test('a brand new default is added on update, already enabled', () => {
  const stored = { rules: [rule('alpha')], seededIds: ['alpha'] };
  const result = plan('update', stored);
  assert.deepEqual(result.rules.map((r) => r.id), ['alpha', 'beta']);
  assert.equal(result.rules[1].enabled, true);
});

test('a default the user deleted is not resurrected', () => {
  const stored = { rules: [rule('alpha')], seededIds: ['alpha', 'beta'] };
  assert.equal('rules' in plan('update', stored), false);
});

test('a default the user renamed is not duplicated', () => {
  const stored = { rules: [rule('beta', { name: 'mine' })], seededIds: [] };
  const result = plan('update', stored);
  assert.deepEqual(result.rules.map((r) => r.id), ['beta', 'alpha']);
  assert.equal(result.rules.filter((r) => r.id === 'beta').length, 1);
});

test('seededIds accumulates and never loses history', () => {
  const stored = { rules: [], seededIds: ['gone'] };
  assert.deepEqual(plan('update', stored).seededIds.sort(), ['alpha', 'beta', 'gone']);
});

test('seeded rules are copies, not shared references', () => {
  const result = plan('install', {});
  result.rules[0].name = 'mutated';
  assert.equal(DEFAULTS[0].name, 'alpha', 'DEFAULT_RULES must not be modified');
});

test('planSeed copes with junk in storage', () => {
  assert.equal(plan('install', { seededIds: 'not-an-array' }).enabled, true);
  assert.equal(plan('update', { rules: 'nope' }).enabled, true, 'treated as from-scratch');
});

// -------------------------------------------------------------------- report

for (const { name, err } of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
