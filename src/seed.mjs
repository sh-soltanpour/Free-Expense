/*
 * seed.mjs — decides what a fresh install or an update writes to storage.
 *
 * Kept as a pure function, separate from background.js, so the "is it on by
 * default?" question is answerable by a test instead of by reading code and
 * hoping. background.js does nothing but call this and write the result.
 */

/*
 * Returns the object to merge into chrome.storage.local, given what is already
 * there. Never returns null — seededIds is always refreshed.
 *
 *   reason          the chrome.runtime.onInstalled reason ('install'|'update'|…)
 *   stored          current { rules, enabled, seededIds }
 *   defaultRules    DEFAULT_RULES from defaults.js
 *   defaultEnabled  DEFAULT_ENABLED from defaults.js
 */
export function planSeed({ reason, stored = {}, defaultRules = [], defaultEnabled = true }) {
  const seeded = new Set(Array.isArray(stored.seededIds) ? stored.seededIds : []);
  const allIds = defaultRules.map((rule) => rule.id);

  // Either a genuine install, or storage that has lost its rules (someone ran
  // storage.local.clear()). Both mean "start from the defaults".
  const fromScratch = reason === 'install' || !Array.isArray(stored.rules);

  if (fromScratch) {
    return {
      rules: structuredClone(defaultRules),
      // Deliberately unconditional: installing the extension turns it on. A
      // stale `false` left behind by a partial storage wipe should not survive
      // a reinstall and leave someone with a silently inert extension.
      enabled: defaultEnabled,
      seededIds: allIds,
    };
  }

  // An update. Introduce defaults the user has never been offered, but leave
  // their own edits — and their master switch — exactly as they set them.
  const existing = new Set(stored.rules.map((rule) => rule.id));
  const additions = defaultRules.filter((rule) => !seeded.has(rule.id) && !existing.has(rule.id));

  const write = { seededIds: [...new Set([...seeded, ...allIds])] };
  if (additions.length) write.rules = stored.rules.concat(structuredClone(additions));
  return write;
}
