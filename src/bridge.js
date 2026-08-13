/*
 * bridge.js — ISOLATED-world content script, document_start.
 *
 * The interceptor lives in the MAIN world and therefore has no chrome.* APIs.
 * This file is the courier between the two: it reads the rules from storage,
 * pushes them into the page as a CustomEvent, keeps them in sync, and forwards
 * the interceptor's hit reports back to the service worker.
 *
 * CustomEvent details are passed as JSON strings on purpose — structured
 * cloning of objects across worlds is not reliable.
 */
(function () {
  'use strict';

  const CONFIG_EVENT = 'rspx:config';
  const HIT_EVENT = 'rspx:hit';

  function alive() {
    // Goes false when the extension is reloaded/updated while the page lives on.
    return Boolean(chrome.runtime && chrome.runtime.id);
  }

  function push(state) {
    try {
      window.dispatchEvent(new CustomEvent(CONFIG_EVENT, {
        detail: JSON.stringify({
          enabled: state.enabled !== false,
          rules: Array.isArray(state.rules) ? state.rules : [],
        }),
      }));
    } catch (err) { /* ignore */ }
  }

  function load() {
    if (!alive()) return;
    try {
      chrome.storage.local.get(['enabled', 'rules'], (state) => {
        if (chrome.runtime.lastError) return;
        push(state || {});
      });
    } catch (err) { /* ignore */ }
  }

  // Fire immediately so the rules land as close to document_start as possible.
  load();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!('enabled' in changes) && !('rules' in changes)) return;
    load();
  });

  window.addEventListener(HIT_EVENT, (event) => {
    if (!alive()) return;
    try {
      const hit = JSON.parse(event.detail);
      chrome.runtime.sendMessage({ type: 'rspx-hit', hit }, () => {
        void chrome.runtime.lastError; // no receiver is fine
      });
    } catch (err) { /* ignore */ }
  });
})();
