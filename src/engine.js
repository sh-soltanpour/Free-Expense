/*
 * engine.js — the rule engine.
 *
 * Loaded in two very different places, so it must stay dependency-free and
 * must not touch chrome.* APIs:
 *   1. the page's MAIN world (by interceptor.js), and
 *   2. extension pages (options.html) for the live rule tester.
 *
 * It exposes itself as globalThis.__RSPX_ENGINE__. interceptor.js deletes that
 * global right after grabbing it so the page never sees it.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- matching

  const PATTERN_CACHE = new Map();
  const VALUE_CACHE = new Map();
  const PATH_CACHE = new Map();

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /*
   * URL pattern syntax:
   *   ""  or "*"                 -> matches everything
   *   "re:^https://api\\..*"     -> JS regular expression (unanchored)
   *   "https://api.example.com/*"-> glob, "*" is the only wildcard, fully anchored
   *   "/v1/users"                -> plain substring match
   */
  function compilePattern(pattern) {
    const key = pattern == null ? '' : String(pattern);
    const cached = PATTERN_CACHE.get(key);
    if (cached) return cached;

    const p = key.trim();
    let compiled;
    if (!p || p === '*') {
      compiled = { kind: 'any' };
    } else if (p.startsWith('re:')) {
      try {
        compiled = { kind: 're', re: new RegExp(p.slice(3)) };
      } catch (err) {
        compiled = { kind: 'never', error: err.message };
      }
    } else if (p.includes('*')) {
      compiled = {
        kind: 're',
        re: new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$'),
      };
    } else {
      compiled = { kind: 'substring', text: p };
    }

    PATTERN_CACHE.set(key, compiled);
    return compiled;
  }

  function urlMatches(pattern, url) {
    const compiled = compilePattern(pattern);
    const target = String(url == null ? '' : url);
    switch (compiled.kind) {
      case 'any': return true;
      case 'never': return false;
      case 'substring': return target.includes(compiled.text);
      default:
        compiled.re.lastIndex = 0;
        return compiled.re.test(target);
    }
  }

  function methodMatches(ruleMethod, actualMethod) {
    const want = String(ruleMethod || 'ANY').toUpperCase();
    if (!want || want === 'ANY' || want === '*') return true;
    return want === String(actualMethod || 'GET').toUpperCase();
  }

  /* Returns the enabled rules that apply to { url, method }, in rule order. */
  function matchRules(rules, ctx) {
    const out = [];
    if (!Array.isArray(rules)) return out;
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      if (!methodMatches(rule.method, ctx && ctx.method)) continue;
      if (!urlMatches(rule.url, ctx && ctx.url)) continue;
      out.push(rule);
    }
    return out;
  }

  // ------------------------------------------------------------- json paths

  /*
   * Path syntax: dots and brackets, with "*" as a wildcard for any array index
   * or object key.
   *   test                 items[0].id           data.user.name
   *   items[*].active      results.*.flags[0]    ["odd.key"].value
   * An empty path (or "$") addresses the whole body.
   */
  function parsePath(path) {
    const key = path == null ? '' : String(path);
    const cached = PATH_CACHE.get(key);
    if (cached) return cached;

    const tokens = [];
    let buffer = '';
    let i = 0;

    const flush = () => {
      if (buffer !== '') { tokens.push(buffer); buffer = ''; }
    };

    while (i < key.length) {
      const ch = key[i];
      if (ch === '.') {
        flush();
        i += 1;
      } else if (ch === '[') {
        flush();
        const end = key.indexOf(']', i);
        if (end === -1) throw new Error('Unclosed "[" in path: ' + key);
        let inner = key.slice(i + 1, end).trim();
        const quoted =
          (inner.startsWith('"') && inner.endsWith('"')) ||
          (inner.startsWith("'") && inner.endsWith("'"));
        if (quoted && inner.length >= 2) inner = inner.slice(1, -1);
        tokens.push(inner);
        i = end + 1;
      } else {
        buffer += ch;
        i += 1;
      }
    }
    flush();

    if (tokens.length && tokens[0] === '$') tokens.shift();
    PATH_CACHE.set(key, tokens);
    return tokens;
  }

  function isObject(v) {
    return v !== null && typeof v === 'object';
  }

  function isPlainObject(v) {
    return isObject(v) && !Array.isArray(v);
  }

  function normalizeKey(node, token) {
    if (!Array.isArray(node)) return token;
    if (!/^-?\d+$/.test(token)) return null; // non-numeric index into an array
    const index = Number(token);
    return index < 0 ? node.length + index : index;
  }

  /*
   * Resolves a path to a list of { parent, key } slots that already exist.
   * Wildcards fan out; missing keys are simply skipped (nothing is created).
   */
  function resolveSlots(root, tokens) {
    let level = [root];
    for (let depth = 0; depth < tokens.length; depth += 1) {
      const token = tokens[depth];
      const last = depth === tokens.length - 1;
      const next = [];

      for (const node of level) {
        if (!isObject(node)) continue;

        if (token === '*') {
          const keys = Array.isArray(node)
            ? node.map((_, idx) => idx)
            : Object.keys(node);
          for (const k of keys) next.push(last ? { parent: node, key: k } : node[k]);
          continue;
        }

        const key = normalizeKey(node, token);
        if (key === null) continue;
        if (last) {
          next.push({ parent: node, key });
        } else if (isObject(node[key])) {
          next.push(node[key]);
        }
      }
      level = next;
    }
    return level;
  }

  function clone(value) {
    if (!isObject(value)) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return clone(source);
    for (const key of Object.keys(source)) {
      target[key] = key in target ? deepMerge(target[key], source[key]) : clone(source[key]);
    }
    return target;
  }

  /* How far along the path does the data actually go? Used for error messages. */
  function deepestExisting(root, tokens) {
    let node = root;
    let depth = 0;
    for (; depth < tokens.length; depth += 1) {
      const token = tokens[depth];
      if (!isObject(node) || token === '*') break;
      const key = normalizeKey(node, token);
      if (key === null || !(key in node)) break;
      node = node[key];
    }
    return { depth, node };
  }

  /*
   * Explains a path that went nowhere, naming the deepest part that did match
   * and what was actually available there — the difference between "it didn't
   * work" and "there is no `add_expense` under `user`".
   */
  function describeMissing(root, tokens, rawPath) {
    const { depth, node } = deepestExisting(root, tokens);
    const reached = depth ? `"${tokens.slice(0, depth).join('.')}"` : 'the root';

    let available = '';
    if (Array.isArray(node)) {
      available = node.length ? ` (an array of ${node.length})` : ' (an empty array)';
    } else if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (!keys.length) {
        available = ' (an empty object)';
      } else {
        const shown = keys.slice(0, 12);
        available = ` — keys there: ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''}`;
      }
    } else {
      available = ` (a ${node === null ? 'null' : typeof node})`;
    }

    return `path "${rawPath}" does not exist; deepest match was ${reached}${available}`;
  }

  /* Walks the path creating missing containers, then assigns. No wildcards. */
  function assignCreating(root, tokens, value) {
    let node = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const key = normalizeKey(node, tokens[i]);
      if (key === null) return false;
      if (!isObject(node[key])) {
        node[key] = /^-?\d+$/.test(tokens[i + 1]) ? [] : {};
      }
      node = node[key];
    }
    const key = normalizeKey(node, tokens[tokens.length - 1]);
    if (key === null) return false;
    node[key] = value;
    return true;
  }

  // -------------------------------------------------------------- mutations

  const OPERATIONS = [
    { id: 'set', label: 'set', needsValue: true, hint: 'Set the field, creating it if missing' },
    { id: 'replace', label: 'change existing', needsValue: true, hint: 'Change a field that must already exist — reports an error if it is missing' },
    { id: 'default', label: 'set if missing', needsValue: true, hint: 'Only set when the field is absent or null' },
    { id: 'merge', label: 'merge', needsValue: true, hint: 'Deep-merge an object into the field' },
    { id: 'push', label: 'append to array', needsValue: true, hint: 'Push the value onto the array at this path' },
    { id: 'remove', label: 'remove', needsValue: false, hint: 'Delete the field (splices arrays)' },
  ];

  function parseValue(raw) {
    const text = raw == null ? '' : String(raw);
    if (VALUE_CACHE.has(text)) return VALUE_CACHE.get(text);

    let result;
    if (text.trim() === '') {
      result = { ok: false, error: 'Value is empty' };
    } else {
      try {
        result = { ok: true, value: JSON.parse(text) };
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }
    VALUE_CACHE.set(text, result);
    return result;
  }

  /*
   * Applies one mutation to `root`, mutating in place where possible.
   * Returns { root, count } — root may be replaced outright when the mutation
   * targets the whole body.
   */
  function applyMutation(root, mutation) {
    if (!mutation || mutation.enabled === false) return { root, count: 0 };

    const op = String(mutation.op || 'set');
    const tokens = parsePath(mutation.path);

    // Catches hand-edited rules that used a dropdown label ("change existing")
    // where the id ("replace") belongs — otherwise it would silently no-op.
    const definition = OPERATIONS.find((o) => o.id === op);
    if (!definition) {
      throw new Error(
        `unknown operation "${op}" — expected one of: ${OPERATIONS.map((o) => o.id).join(', ')}`
      );
    }
    const needsValue = definition.needsValue;

    let value;
    if (needsValue) {
      const parsed = parseValue(mutation.value);
      if (!parsed.ok) throw new Error('Invalid JSON value: ' + parsed.error);
      value = parsed.value;
    }

    // Whole-body operations.
    if (tokens.length === 0) {
      if (op === 'set' || op === 'replace') return { root: clone(value), count: 1 };
      if (op === 'merge') return { root: deepMerge(root, value), count: 1 };
      if (op === 'push' && Array.isArray(root)) {
        root.push(clone(value));
        return { root, count: 1 };
      }
      return { root, count: 0 };
    }

    /*
     * `replace` is the strict counterpart to `set`: it never creates anything,
     * and a path that matches nothing is an error rather than a silent no-op.
     * Use it when a wrong path should be loud instead of inventing a branch
     * the app will never read.
     */
    if (op === 'replace') {
      if (!isObject(root)) {
        throw new Error(`path "${mutation.path}" does not exist; the body is not an object or array`);
      }
      const present = resolveSlots(root, tokens).filter(({ parent, key }) => (
        Array.isArray(parent) ? key >= 0 && key < parent.length : key in parent
      ));
      if (!present.length) throw new Error(describeMissing(root, tokens, mutation.path));

      for (const { parent, key } of present) parent[key] = clone(value);
      return { root, count: present.length };
    }

    if (!isObject(root)) return { root, count: 0 };

    let count = 0;

    if (op === 'set' && !tokens.includes('*')) {
      // The only case where we create missing intermediate containers.
      if (assignCreating(root, tokens, clone(value))) count += 1;
      return { root, count };
    }

    let slots = resolveSlots(root, tokens);

    // Splicing shifts later indices, so remove array entries highest-first.
    // resolveSlots emits each parent's keys in ascending order, so reversing
    // the whole list is enough.
    if (op === 'remove') slots = slots.slice().reverse();

    for (const slot of slots) {
      const { parent, key } = slot;
      const current = parent[key];

      switch (op) {
        case 'set':
          parent[key] = clone(value);
          count += 1;
          break;

        case 'default':
          if (current === undefined || current === null) {
            parent[key] = clone(value);
            count += 1;
          }
          break;

        case 'merge':
          parent[key] = deepMerge(isObject(current) ? current : {}, value);
          count += 1;
          break;

        case 'push':
          if (Array.isArray(current)) {
            current.push(clone(value));
            count += 1;
          } else if (current === undefined || current === null) {
            parent[key] = [clone(value)];
            count += 1;
          }
          break;

        case 'remove':
          if (Array.isArray(parent) && typeof key === 'number') {
            if (key >= 0 && key < parent.length) { parent.splice(key, 1); count += 1; }
          } else if (key in parent) {
            delete parent[key];
            count += 1;
          }
          break;

        default:
          break;
      }
    }

    // `remove` with a wildcard over an array splices while iterating, which
    // shifts later indices. Resolve-then-splice highest-first instead.
    return { root, count };
  }

  /*
   * Applies every mutation of every matched rule.
   * Returns { data, count, errors }. `data` is safe to stringify.
   */
  function applyRules(matched, data) {
    let root = data;
    let count = 0;
    const errors = [];

    for (const rule of matched || []) {
      const mutations = Array.isArray(rule.mutations) ? rule.mutations : [];
      for (const mutation of mutations) {
        try {
          const result = applyMutation(root, mutation);
          root = result.root;
          count += result.count;
        } catch (err) {
          errors.push({ rule: rule.name || rule.id, path: mutation && mutation.path, error: err.message });
        }
      }
    }

    return { data: root, count, errors };
  }

  /* Last matched rule that specifies a status wins. */
  function statusOverride(matched) {
    let status = null;
    for (const rule of matched || []) {
      const raw = rule && rule.status;
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed >= 200 && parsed <= 599) status = parsed;
    }
    return status;
  }

  function looksLikeJson(contentType) {
    if (!contentType) return true; // no content-type at all: worth a parse attempt
    const ct = String(contentType).toLowerCase();
    return ct.includes('json') || ct.includes('javascript') || ct.includes('text/plain');
  }

  const api = {
    OPERATIONS,
    urlMatches,
    methodMatches,
    matchRules,
    parsePath,
    parseValue,
    applyMutation,
    applyRules,
    statusOverride,
    looksLikeJson,
    compilePattern,
  };

  global.__RSPX_ENGINE__ = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
