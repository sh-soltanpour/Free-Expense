/*
 * defaults.js — the rules every fresh install starts with.
 *
 * THIS IS THE FILE TO EDIT if you want to ship the extension pre-loaded with
 * your own rules. Everything here is written into chrome.storage.local the
 * first time the extension is installed, and rules marked `enabled: true` are
 * live from that moment on — the user does not have to switch anything on.
 *
 * Upgrades are handled by id: on a version update, any rule below whose `id`
 * has never been seeded before is added. Rules the user has edited or deleted
 * are left exactly as the user left them, so shipping a new default is safe.
 *
 * Rule shape
 * ----------
 *   id        stable, unique; the upgrade path keys off it — never reuse one
 *   name      shown in the UI
 *   enabled   live on install when true
 *   method    "ANY" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | ...
 *   url       "" / "*"            match everything
 *             "/api/v1/users"     substring match
 *             "https://x.com/*"   glob, "*" is the wildcard, anchored
 *             "re:^https://api\\." regular expression
 *   status    optional HTTP status to report instead of the real one
 *   mutations ordered list of edits applied to the parsed JSON body
 *
 * Mutation ops
 * ------------
 *   set       write the value, creating missing parents along the way
 *   default   write only when the field is absent or null
 *   merge     deep-merge an object into the field
 *   push      append the value to the array at that path
 *   remove    delete the field
 *
 * Paths use dots, brackets and "*" as a wildcard over array indices or object
 * keys:  test  •  data.user.name  •  items[0].id  •  items[*].active
 * An empty path addresses the whole body.
 *
 * `value` is always a JSON literal *as text*: "true", "42", "\"hello\"",
 * "{\"a\": 1}", "null".
 */

export const DEFAULT_ENABLED = true;

export const DEFAULT_RULES = [
  {
    id: 'splitwise',
    name: 'Splitwise',
    enabled: true,
    method: 'GET',
    url: 'https://secure.splitwise.com/api/v3.0/get_main_data',
    status: '',
    mutations: [
      // `op` is the operation *id*, not the label shown in the dropdown:
      // set | replace | default | merge | push | remove.
      // "replace" is the strict one — it errors instead of creating the field.
      // `value` is a JSON literal as text, so `true`, never `True`.
      { enabled: true, op: 'replace', path: 'metadata.features.add_expense.enabled', value: 'true' },
    ],
  },
];
