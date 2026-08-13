/* popup.js — quick switches for the current tab. */
import { loadState, saveRules, setEnabled } from '../store.js';

const engine = globalThis.__RSPX_ENGINE__;

const el = {
  master: document.getElementById('masterToggle'),
  masterLabel: document.getElementById('masterLabel'),
  hitCount: document.getElementById('hitCount'),
  context: document.getElementById('context'),
  list: document.getElementById('ruleList'),
  empty: document.getElementById('emptyState'),
  openOptions: document.getElementById('openOptions'),
  template: document.getElementById('ruleTemplate'),
};

let rules = [];

function renderRules(pageUrl) {
  el.list.replaceChildren(...rules.map((rule) => {
    const node = el.template.content.firstElementChild.cloneNode(true);
    const toggle = node.querySelector('[data-field="enabled"]');

    toggle.checked = rule.enabled !== false;
    node.classList.toggle('off', !toggle.checked);
    node.querySelector('.rule-name').textContent = rule.name || 'Unnamed rule';
    node.querySelector('.rule-url').textContent = `${rule.method && rule.method !== 'ANY' ? rule.method + ' ' : ''}${rule.url || '(any URL)'}`;

    // A hint that this rule's pattern covers the page you're looking at.
    // Requests can of course go anywhere, so this is a hint, not a promise.
    if (pageUrl && engine.urlMatches(rule.url, pageUrl)) {
      node.querySelector('[data-role="match"]').hidden = false;
    }

    toggle.addEventListener('change', () => {
      rule.enabled = toggle.checked;
      node.classList.toggle('off', !toggle.checked);
      saveRules(rules);
    });

    return node;
  }));

  el.empty.hidden = rules.length > 0;
}

function syncMasterLabel() {
  el.masterLabel.textContent = el.master.checked ? 'Interception on' : 'Paused';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = await loadState();

  rules = state.rules;
  el.master.checked = state.enabled;
  syncMasterLabel();

  let pageUrl = '';
  try {
    pageUrl = tab && tab.url ? tab.url : '';
    el.context.textContent = pageUrl ? new URL(pageUrl).host : '';
  } catch (err) {
    el.context.hidden = true;
  }

  renderRules(pageUrl);

  if (tab) {
    chrome.runtime.sendMessage({ type: 'rspx-get-hits', tabId: tab.id }, (response) => {
      void chrome.runtime.lastError;
      const count = (response && response.count) || 0;
      el.hitCount.textContent = count ? `${count} rewritten` : 'nothing rewritten yet';
    });
  }

  el.master.addEventListener('change', () => {
    setEnabled(el.master.checked);
    syncMasterLabel();
  });

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
