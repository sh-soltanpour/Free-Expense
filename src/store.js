/* store.js — thin storage helpers shared by the options page and the popup. */

export async function loadState() {
  const stored = await chrome.storage.local.get(['rules', 'enabled']);
  return {
    enabled: stored.enabled !== false,
    rules: Array.isArray(stored.rules) ? stored.rules : [],
  };
}

export async function saveRules(rules) {
  await chrome.storage.local.set({ rules });
}

export async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled });
}

export function newRule(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'New rule',
    enabled: true,
    method: 'ANY',
    url: '',
    status: '',
    mutations: [newMutation()],
    ...overrides,
  };
}

export function newMutation(overrides = {}) {
  return { enabled: true, op: 'set', path: '', value: 'true', ...overrides };
}

/* Accepts either a bare array of rules or a full { rules: [...] } export. */
export function normalizeImport(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.rules;
  if (!Array.isArray(list)) throw new Error('Expected an array of rules, or an object with a "rules" array.');

  return list.map((raw) => ({
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    name: String(raw.name || 'Imported rule'),
    enabled: raw.enabled !== false,
    method: String(raw.method || 'ANY').toUpperCase(),
    url: String(raw.url || ''),
    status: raw.status === undefined || raw.status === null ? '' : String(raw.status),
    mutations: (Array.isArray(raw.mutations) ? raw.mutations : []).map((m) => ({
      enabled: m.enabled !== false,
      op: String(m.op || 'set'),
      path: String(m.path || ''),
      value: m.value === undefined || m.value === null ? '' : String(m.value),
    })),
  }));
}
