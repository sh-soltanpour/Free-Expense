/* options.js — the rule editor. Autosaves; engine.js is loaded ahead of it. */
import { loadState, saveRules, setEnabled, newRule, newMutation, normalizeImport } from '../store.js';
import { DEFAULT_RULES } from '../defaults.js';

const engine = globalThis.__RSPX_ENGINE__;
const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const el = {
  list: document.getElementById('ruleList'),
  empty: document.getElementById('emptyState'),
  addRule: document.getElementById('addRule'),
  master: document.getElementById('masterToggle'),
  saveState: document.getElementById('saveState'),
  exportBtn: document.getElementById('exportRules'),
  importBtn: document.getElementById('importRules'),
  importFile: document.getElementById('importFile'),
  restoreBtn: document.getElementById('restoreDefaults'),
  testUrl: document.getElementById('testUrl'),
  testMethod: document.getElementById('testMethod'),
  testInput: document.getElementById('testInput'),
  testOutput: document.getElementById('testOutput'),
  testSummary: document.getElementById('testSummary'),
  ruleTemplate: document.getElementById('ruleTemplate'),
  mutationTemplate: document.getElementById('mutationTemplate'),
};

let rules = [];
const collapsed = new Set();

// ------------------------------------------------------------------- saving

let saveTimer = null;
let flashTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  el.saveState.textContent = '';
  saveTimer = setTimeout(async () => {
    saveTimer = null; // the onChanged listener keys off this to avoid clobbering an in-flight edit
    await saveRules(rules);
    el.saveState.textContent = 'Saved';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.saveState.textContent = ''; }, 1600);
  }, 400);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveRules(rules);
}

// ----------------------------------------------------------------- rendering

function fillSelect(select, options) {
  select.replaceChildren(...options.map(({ value, label, title }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (title) option.title = title;
    return option;
  }));
}

function summarize(rule) {
  const method = rule.method && rule.method !== 'ANY' ? rule.method + ' ' : '';
  const url = rule.url || '(any URL)';
  const count = (rule.mutations || []).filter((m) => m.enabled !== false).length;
  return `${method}${url}  ·  ${count} change${count === 1 ? '' : 's'}`;
}

function renderMutation(rule, mutation) {
  const node = el.mutationTemplate.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector('[data-field="enabled"]');
  const op = node.querySelector('[data-field="op"]');
  const path = node.querySelector('[data-field="path"]');
  const value = node.querySelector('[data-field="value"]');

  fillSelect(op, engine.OPERATIONS.map((o) => ({ value: o.id, label: o.label, title: o.hint })));

  enabled.checked = mutation.enabled !== false;
  op.value = mutation.op || 'set';
  path.value = mutation.path || '';
  value.value = mutation.value || '';

  const syncDisabledLook = () => node.classList.toggle('off', !enabled.checked);
  const syncValueState = () => {
    const needsValue = (engine.OPERATIONS.find((o) => o.id === op.value) || {}).needsValue;
    value.disabled = !needsValue;
    value.classList.toggle('invalid', Boolean(needsValue) && !engine.parseValue(value.value).ok);
    value.title = needsValue && !engine.parseValue(value.value).ok
      ? 'Not valid JSON — strings need quotes, e.g. "hello"'
      : '';
  };

  syncDisabledLook();
  syncValueState();

  enabled.addEventListener('change', () => {
    mutation.enabled = enabled.checked;
    syncDisabledLook();
    touched(rule);
  });
  op.addEventListener('change', () => {
    mutation.op = op.value;
    syncValueState();
    touched(rule);
  });
  path.addEventListener('input', () => { mutation.path = path.value; touched(rule); });
  value.addEventListener('input', () => {
    mutation.value = value.value;
    syncValueState();
    touched(rule);
  });

  node.querySelector('[data-action="delete-mutation"]').addEventListener('click', () => {
    const index = rule.mutations.indexOf(mutation);
    if (index >= 0) rule.mutations.splice(index, 1);
    render();
    scheduleSave();
  });

  return node;
}

function renderRule(rule) {
  const node = el.ruleTemplate.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector('[data-field="enabled"]');
  const name = node.querySelector('[data-field="name"]');
  const method = node.querySelector('[data-field="method"]');
  const url = node.querySelector('[data-field="url"]');
  const status = node.querySelector('[data-field="status"]');
  const summary = node.querySelector('.rule-summary');
  const rows = node.querySelector('.mutation-rows');

  fillSelect(method, METHODS.map((m) => ({ value: m, label: m === 'ANY' ? 'Any method' : m })));

  enabled.checked = rule.enabled !== false;
  name.value = rule.name || '';
  method.value = METHODS.includes(rule.method) ? rule.method : 'ANY';
  url.value = rule.url || '';
  status.value = rule.status || '';
  summary.textContent = summarize(rule);

  node.classList.toggle('disabled', !enabled.checked);
  node.classList.toggle('collapsed', collapsed.has(rule.id));

  const checkUrl = () => {
    const compiled = engine.compilePattern(url.value);
    url.classList.toggle('invalid', compiled.kind === 'never');
    url.title = compiled.error ? 'Invalid regular expression: ' + compiled.error : '';
  };
  checkUrl();

  enabled.addEventListener('change', () => {
    rule.enabled = enabled.checked;
    node.classList.toggle('disabled', !enabled.checked);
    touched(rule, summary);
  });
  name.addEventListener('input', () => { rule.name = name.value; touched(rule, summary); });
  method.addEventListener('change', () => { rule.method = method.value; touched(rule, summary); });
  url.addEventListener('input', () => {
    rule.url = url.value;
    checkUrl();
    touched(rule, summary);
  });
  status.addEventListener('input', () => {
    rule.status = status.value.replace(/[^\d]/g, '');
    status.value = rule.status;
    touched(rule, summary);
  });

  for (const mutation of rule.mutations || []) rows.append(renderMutation(rule, mutation));

  node.querySelector('[data-action="add-mutation"]').addEventListener('click', () => {
    rule.mutations = rule.mutations || [];
    rule.mutations.push(newMutation());
    render();
    scheduleSave();
  });

  node.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
    const copy = structuredClone(rule);
    copy.id = crypto.randomUUID();
    copy.name = rule.name + ' (copy)';
    rules.splice(rules.indexOf(rule) + 1, 0, copy);
    render();
    scheduleSave();
  });

  node.querySelector('[data-action="delete"]').addEventListener('click', () => {
    if (!confirm(`Delete "${rule.name || 'this rule'}"?`)) return;
    rules.splice(rules.indexOf(rule), 1);
    render();
    scheduleSave();
  });

  node.querySelector('[data-action="collapse"]').addEventListener('click', (event) => {
    const isCollapsed = collapsed.has(rule.id);
    if (isCollapsed) collapsed.delete(rule.id); else collapsed.add(rule.id);
    node.classList.toggle('collapsed', !isCollapsed);
    event.currentTarget.setAttribute('aria-expanded', String(isCollapsed));
  });

  return node;
}

/* A field changed: refresh the derived bits, save, re-run the tester. */
function touched(rule, summaryNode) {
  if (summaryNode) summaryNode.textContent = summarize(rule);
  scheduleSave();
  runTest();
}

function render() {
  el.list.replaceChildren(...rules.map(renderRule));
  el.empty.hidden = rules.length > 0;
  runTest();
}

// ------------------------------------------------------------------- tester

function runTest() {
  const ctx = { url: el.testUrl.value.trim(), method: el.testMethod.value };
  const matched = engine.matchRules(rules, ctx);
  const parts = [];

  if (!ctx.url) {
    el.testOutput.value = '';
    el.testSummary.textContent = 'Enter a URL above to test against your rules.';
    return;
  }

  let data;
  try {
    data = JSON.parse(el.testInput.value);
  } catch (err) {
    el.testOutput.value = '';
    el.testSummary.innerHTML = '<span class="err">Sample body is not valid JSON.</span>';
    return;
  }

  if (!matched.length) {
    el.testOutput.value = el.testInput.value;
    el.testSummary.innerHTML = '<span class="err">No rule matches this URL — the response would pass through untouched.</span>';
    return;
  }

  const result = engine.applyRules(matched, data);
  el.testOutput.value = JSON.stringify(result.data, null, 2);

  for (const rule of matched) parts.push(`<span class="pill">${escapeHtml(rule.name || 'unnamed')}</span>`);
  parts.push(`${result.count} field${result.count === 1 ? '' : 's'} changed`);

  const status = engine.statusOverride(matched);
  if (status !== null) parts.push(` · status reported as <code>${status}</code>`);
  for (const problem of result.errors) {
    parts.push(`<div class="err">${escapeHtml(problem.rule)} → ${escapeHtml(problem.path || '')}: ${escapeHtml(problem.error)}</div>`);
  }

  el.testSummary.innerHTML = parts.join(' ');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ------------------------------------------------------------ import/export

function exportRules() {
  const blob = new Blob([JSON.stringify({ rules }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'free-expense-rules.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importRules(file) {
  try {
    const imported = normalizeImport(JSON.parse(await file.text()));
    const replace = rules.length === 0 || confirm(
      `Import ${imported.length} rule(s)?\n\nOK — replace your current rules.\nCancel — append them instead.`
    );
    rules = replace ? imported : rules.concat(imported);
    render();
    await saveNow();
    el.saveState.textContent = 'Imported';
  } catch (err) {
    alert('Could not import that file:\n\n' + err.message);
  }
}

// -------------------------------------------------------------------- setup

async function init() {
  fillSelect(el.testMethod, METHODS.map((m) => ({ value: m, label: m === 'ANY' ? 'Any' : m })));
  el.testMethod.value = 'GET';
  el.testUrl.value = 'https://httpbin.org/json';

  const state = await loadState();
  rules = state.rules;
  el.master.checked = state.enabled;
  render();

  el.master.addEventListener('change', () => setEnabled(el.master.checked));

  el.addRule.addEventListener('click', () => {
    rules.unshift(newRule());
    render();
    scheduleSave();
    el.list.querySelector('.rule-name')?.focus();
  });

  el.exportBtn.addEventListener('click', exportRules);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', () => {
    const [file] = el.importFile.files;
    if (file) importRules(file);
    el.importFile.value = '';
  });

  el.restoreBtn.addEventListener('click', async () => {
    if (!confirm('Add the shipped default rules back?\n\nYour existing rules are kept; defaults you have deleted reappear.')) return;
    const have = new Set(rules.map((rule) => rule.id));
    rules = rules.concat(structuredClone(DEFAULT_RULES).filter((rule) => !have.has(rule.id)));
    render();
    await saveNow();
    el.saveState.textContent = 'Restored';
  });

  for (const node of [el.testUrl, el.testInput]) node.addEventListener('input', runTest);
  el.testMethod.addEventListener('change', runTest);

  // Another surface (the popup) may have changed things underneath us.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('enabled' in changes) el.master.checked = changes.enabled.newValue !== false;
    if ('rules' in changes && !saveTimer && document.activeElement === document.body) {
      rules = changes.rules.newValue || [];
      render();
    }
  });
}

init();
