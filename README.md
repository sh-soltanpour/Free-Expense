# Free Expense

A Chrome extension that rewrites fields in JSON API responses before the page
sees them. You give it a URL and a list of changes — *make `test` always
`true`*, *set every `items[*].active` to `true`* — and the page receives the
modified body as if the server had sent it.

`Comes with a golden default rule that makes your expense recording easier :)`

## Install

1. Download the `.zip` from [Releases](../../releases) and unzip it
   *(or `git clone` this repo)*
2. Open `chrome://extensions`
3. Turn on **Developer mode**, top-right
4. Click **Load unpacked** and pick the folder — the one containing
   `manifest.json`

Needs Chrome 111+. Keep the folder where it is; Chrome loads it from that path
on every startup.

## Use

Click the toolbar icon to switch rules on and off. **Edit rules** opens the
editor, where each rule is a URL to match plus a list of changes to apply.

| Field | Example |
| --- | --- |
| **URL** | `https://api.example.com/v1/*` |
| **Method** | `GET`, or `Any` |
| **Field path** | `test` · `data.user.name` · `items[*].active` |
| **Value** | `true` · `42` · `"text"` · `{"a": 1}` — JSON, so strings need quotes |

Pick an action for each change:

- **set** — write the value, creating the field if it's missing
- **change existing** — same, but error out if the field isn't already there
- **set if missing** · **merge** · **append to array** · **remove**

The panel at the bottom of the editor lets you paste a sample response and see
exactly what the page would get, before going anywhere near a real request.

**Note:** the DevTools Network tab shows the *original* response, not the
rewritten one — check the Console or the app itself.

## More

- [Full reference](docs/REFERENCE.md) — pattern syntax, all operations,
  debugging with `__RSPX__`, and how the interception works
- [`src/defaults.js`](src/defaults.js) — rules that ship pre-installed

```bash
npm test          # 84 tests
npm run package   # -> dist/free-expense-<version>.zip
```
