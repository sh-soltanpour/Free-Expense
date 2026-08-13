/*
 * background.js — service worker.
 *
 * Two jobs: seed the shipped default rules (see defaults.js), and keep the
 * toolbar badge showing how many responses were rewritten in each tab.
 */
import { DEFAULT_ENABLED, DEFAULT_RULES } from './defaults.js';

const BADGE_COLOR = '#6366f1';
const BADGE_COLOR_OFF = '#9ca3af';

// ------------------------------------------------------------------ seeding

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(['rules', 'enabled', 'seededIds']);
  const seeded = new Set(Array.isArray(stored.seededIds) ? stored.seededIds : []);

  if (details.reason === 'install' || !Array.isArray(stored.rules)) {
    // Fresh install: ship everything, live immediately.
    await chrome.storage.local.set({
      rules: structuredClone(DEFAULT_RULES),
      enabled: stored.enabled === undefined ? DEFAULT_ENABLED : stored.enabled,
      seededIds: DEFAULT_RULES.map((rule) => rule.id),
    });
    return;
  }

  // Update: introduce defaults the user has never seen, without disturbing the
  // ones they already have (or deliberately deleted).
  const existing = new Set(stored.rules.map((rule) => rule.id));
  const additions = DEFAULT_RULES.filter((rule) => !seeded.has(rule.id) && !existing.has(rule.id));

  if (additions.length) {
    await chrome.storage.local.set({
      rules: stored.rules.concat(structuredClone(additions)),
    });
  }

  await chrome.storage.local.set({
    seededIds: [...new Set([...seeded, ...DEFAULT_RULES.map((rule) => rule.id)])],
  });
});

// ------------------------------------------------------------ dev reload

/*
 * Alt+Shift+R reloads the extension from disk and refreshes the tab you were
 * looking at — the whole edit/reload loop in one keystroke.
 *
 * chrome.runtime.reload() tears down this worker, so the tab to refresh is
 * parked in storage and picked up when the worker starts again below.
 */
const RELOAD_TAB_KEY = '__rspx_reload_tab';

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'reload-extension') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && !String(tab.url || '').startsWith('chrome://')) {
    await chrome.storage.local.set({ [RELOAD_TAB_KEY]: tab.id });
  }
  chrome.runtime.reload();
});

// Runs on every worker start, including the one right after a reload.
chrome.storage.local.get(RELOAD_TAB_KEY).then((stored) => {
  const tabId = stored[RELOAD_TAB_KEY];
  if (tabId === undefined) return;
  chrome.storage.local.remove(RELOAD_TAB_KEY);
  chrome.tabs.reload(tabId).catch(() => {});
});

// -------------------------------------------------------------------- badge

const hits = new Map(); // tabId -> count

function paintBadge(tabId, count, enabled) {
  const text = !enabled ? '' : count > 999 ? '999+' : count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? BADGE_COLOR : BADGE_COLOR_OFF }).catch(() => {});
  chrome.action.setTitle({
    tabId,
    title: enabled
      ? `Free Expense — ${count} response${count === 1 ? '' : 's'} rewritten`
      : 'Free Expense — paused',
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'rspx-hit' || !sender.tab) return;

  const tabId = sender.tab.id;
  const count = (hits.get(tabId) || 0) + 1;
  hits.set(tabId, count);
  paintBadge(tabId, count, true);
});

// A new document in the tab starts the count over.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  hits.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  hits.delete(tabId);
});

// Reflect the master switch on every tab's badge as soon as it is flipped.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('enabled' in changes)) return;
  const enabled = changes.enabled.newValue !== false;
  for (const [tabId, count] of hits) paintBadge(tabId, count, enabled);
});

// The popup asks for the current tab's counter.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'rspx-get-hits') return undefined;
  sendResponse({ count: hits.get(message.tabId) || 0 });
  return true;
});
