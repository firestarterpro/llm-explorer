# Phase 3.5 Pre-Refactor Audit

Reviewed against the working tree on 2026-10-19 (uncommitted changes included).
`synthesize.py` lives at `C:\llm\src\synthesize.py`, outside this repo, so it was not reviewed.

Line numbers refer to the current files: `main.js` (385), `scrapers.js` (133),
`preload.js` (11), `index.html` (1341; `<script>` is lines 418–1339).

## Corrections to the earlier handoff

- **No SingletonLock crash today.** Each provider already has its own profile
  (`user_data_<id>`), so different providers never share a directory. The collision risk
  is the same provider twice at once (see 1.2).
- **IPC listeners are not duplicated.** They are registered once at page load
  (`index.html:1280-1338`), not per send.
- **`contextIsolation: true` / `nodeIntegration: false` are already set** (`main.js:66-70`),
  and preload exposes a narrow API. This is fine.
- **"Wait for the Stop button to disappear" does not exist in code.** Only the
  text-stability poll exists (`scrapers.js:44-55`).
- **Custom-LLM API keys ARE in renderer state.** `CH[].apiKey` (`index.html:491`) is sent
  over IPC on every prompt (`index.html:1255`). Persisting `CH` to localStorage as planned
  would write keys to disk in plaintext.
- **The demo is a separate fork.** `demo/index.html` (1220 lines) has already drifted
  from `index.html`.

## Bugs to fix before (or during) the refactor

These are cheap fixes, and the refactor would otherwise build on top of them.

### B1. Late replies land in the wrong turn — `index.html:1282, 1300, 1325`
**Flaw:** every IPC handler writes to `turns[turns.length - 1]`. If you send a second
prompt before the first finishes, turn 1's replies and synthesis go into turn 2. Branching
makes this unavoidable.
**Patch:** generate `turnId` in the renderer, pass it through `sendPrompt`, and echo it back
in every `reply-received` / `hybrid-stream` / `hybrid-complete` payload.
```js
// renderer
const turnId = crypto.randomUUID();
window.api.sendPrompt({ turnId, promptText, activeModels, engine });
// handler
window.api.onReplyReceived(({ turnId, model, text, status }) => {
  const t = nodes[turnId]; if (!t) return;
  t.replies[model] = { text, status };
  renderTurn(turnId);
});
```

### B2. Synthesis stream overwrites a single-model card — `index.html:1308-1313`
**Flaw:** the stream handler writes into the last `.hybrid-body` in the DOM. Single-model
tabs reuse that class (`index.html:1013`), so if you are on the ChatGPT tab during
synthesis, the ChatGPT card's text gets replaced with hybrid text.
**Patch:** target by id, not by position: `` document.querySelector(`[data-turn="${turnId}"] .hybrid-body[data-kind="hybrid"]`) ``.

### B3. Long replies are cut off and still reported as success — `scrapers.js:44-55`
**Flaw:** the loop gives up after 30 attempts (~30 s), then returns whatever partial text
it has, as long as it's over 5 characters. Reasoning models and long answers routinely
exceed 30 s.
It can also finish early: any placeholder text matching `responseSelector` that stays the
same for 3 s before generation starts counts as "done".
**Patch:** count the matching elements *before* submitting, wait for a new one to appear,
then require it to stay stable. Add an optional per-provider `doneSelector` and
`timeoutMs`. Mark a timeout as `status: 'partial'`, not success.
```js
const before = await page.locator(cfg.responseSelector).count();
await submit();
await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length > n,
  [cfg.responseSelector, before], { timeout: 30000 });
const deadline = Date.now() + (cfg.timeoutMs ?? 180000);
let prev = '', stable = 0;
while (stable < 3 && Date.now() < deadline) {
  const done = cfg.doneSelector ? !(await page.locator(cfg.doneSelector).count()) : true;
  const cur = await page.locator(cfg.responseSelector).last().innerText().catch(() => '');
  stable = (cur === prev && cur.length > 0 && done) ? stable + 1 : 0;
  prev = cur; await page.waitForTimeout(1000);
}
return { text: prev, status: stable >= 3 ? 'success' : 'partial' };
```

### B4. No timeouts on any HTTP call — `main.js:123, 204`
**Flaw:** one hung custom endpoint stalls `runConcurrent`, and with it the whole turn's
synthesis. DeepSeek streaming has the same problem.
**Patch:** `fetch(url, { ..., signal: AbortSignal.timeout(120000) })`.

### B5. A missing Python executable can crash the main process — `main.js:103-113`
**Flaw:** there is no `'error'` listener on the spawned process. If `PYTHON_EXE` is
missing, the `ENOENT` error becomes an uncaught exception in main. There is also no
timeout, nothing kills the process on quit, and writing to stdin after Python dies raises
an unhandled `EPIPE`.
**Patch:**
```js
const py = spawn(PYTHON_EXE, [PYTHON_SCRIPT_PATH], { windowsHide: true });
activeChildren.add(py);
const killTimer = setTimeout(() => py.kill(), 180000);
py.on('error', err => { event.reply('hybrid-stream', `\n[Python failed: ${err.message}]\n`); });
py.stdin.on('error', () => {});
py.on('close', () => { clearTimeout(killTimer); activeChildren.delete(py); event.reply('hybrid-complete'); });
// once:
app.on('before-quit', () => activeChildren.forEach(p => p.kill()));
```
Note that `close` can follow `error`, so make sure `hybrid-complete` is sent only once.

### B6. The custom model sends its display name as the model ID — `main.js:127`
**Flaw:** `model: model.name` sends "My Local Llama" where the API expects something like
`llama3.1:8b`.
**Patch:** add a separate `modelId` field to the custom-model form and send that.

### B7. Prefix, detail slider, and history depth never reach any LLM — `index.html:1240-1276`
**Flaw:** `sendPrompt` sends only the raw prompt. Prefix text, slider "heat", and the
history-context depth are UI-only right now. Phase 3.5 is building more UI on controls
that do nothing.
**Patch:** build the outgoing prompt per model in the renderer:
`[prefix if prefixOn] + [history context for depth d] + prompt`. Then send
`perModelPrompts: { [id]: text }`. Decide what "heat" means: a length instruction in the
prefix, or `max_tokens` for API models.

### B8. Placeholder and fake values
- The `Scraping...` loading text is stored as the reply (`index.html:1284`), because
  `status` is ignored.
- `hybrid.score = 100` is hardcoded on completion (`index.html:1327`).
- `parseScore` looks for `SCORE: x/10`, which nothing produces.
- The Retry, Sync, Prefix, Hybrid and Free APIs buttons and the Branch pill have no
  handlers.

Either wire these up or hide them, so the animations don't polish dead controls.

## Pillar 1 — Playwright lifecycle (`scrapers.js`, `main.js`)

1.1 **Cold boot per query** (`scrapers.js:11, 72`): each query launches and closes a full
Chromium, which costs ~2–5 s per provider. Keep one persistent context per provider alive
and open a new page per query.
```js
const contexts = new Map();          // id -> Promise<BrowserContext>
function getContext(id) {
  if (!contexts.has(id)) {
    const p = chromium.launchPersistentContext(getDataDir(id), { headless: HEADLESS });
    p.then(ctx => ctx.on('close', () => contexts.delete(id)), () => contexts.delete(id));
    contexts.set(id, p);
  }
  return contexts.get(id);
}
// in genericScrape: const page = await (await getContext(cfg.id)).newPage(); ... finally page.close()
// on quit: for (const p of contexts.values()) (await p).close();
```
With warm contexts, the cap of 3 concurrent browsers becomes a cap on open browsers, so
add idle eviction (close a context after N minutes unused).

1.2 **Same-profile collision:** Login Mode (`main.js:365`) and a scrape of the same
provider both call `launchPersistentContext` on the same directory, which crashes.
`getContext()` above fixes this if Login Mode uses it too, with a headed flag.

1.3 **Launch flags** (`scrapers.js:14-15`):
- Remove `--no-sandbox`. It disables Chromium's sandbox for a browser that visits
  third-party sites.
- Remove the hardcoded `Chrome/120` user agent. It doesn't match the bundled Chromium,
  which causes more breakage than it prevents.

I'm not going to help tune these flags to get past bot detection. When a site walls you,
solve the CAPTCHA manually in Login Mode or use that vendor's API (see 2.3).

1.4 **The `user_data/` directory** is orphaned (left from an older layout). Delete it.

## Pillar 2 — One provider registry (zero edits to add a site or API)

2.1 **Three copies of the provider list:**
- `scrapers.js:79` (scrape config)
- `index.html:427-438` (`CH` UI state)
- `demo/index.html`

Adding a site means editing all three. Replace them with one registry that main owns:
```jsonc
// providers.json (built-ins, in repo) + userData/providers.json (user-added, merged on top)
{ "id": "chatgpt", "name": "ChatGPT", "emoji": "🤖", "kind": "scrape",
  "url": "https://chatgpt.com", "inputSelector": "#prompt-textarea",
  "submit": "enter", "responseSelector": ".markdown",
  "doneSelector": "button[data-testid='stop-button']", "timeoutMs": 180000 }
{ "id": "my-llama", "name": "Local Llama", "emoji": "🧩", "kind": "api",
  "endpoint": "http://localhost:11434/v1/chat/completions", "modelId": "llama3.1:8b",
  "keyRef": "my-llama" }   // keyRef -> safeStorage entry; null if no key needed
```
- Main loads it and exposes `api.getProviders()`.
- The renderer builds `CH` from it, merging saved UI prefs (`checked`, `value`, `locked`,
  prefix, order) by `id`.
- `isStatic` becomes `kind === 'scrape' && search: true` (or a `capabilities` field).
- "Add custom LLM / add site" writes to `userData/providers.json` through IPC.

2.2 **Decouple `event`:** `genericScrape(cfg, prompt)` and `runCustomModel(cfg, prompt)`
should both return `{ id, status, text, ms }`. A single dispatcher in main does
`adapters[cfg.kind](cfg, prompt)` and emits IPC with `turnId`. New kinds (e.g.
`"ollama"`, `"anthropic"`) become new adapter entries, not edits to the
`user-prompt` handler.

2.3 **API keys:** I recommend against a plain text file. The `safeStorage` code you
already have (`main.js:37-60`) is the better option: it's encrypted by Windows DPAPI and
tied to your user account. Generalize it to `keys: { [keyRef]: enc }` with
`setKey(ref, key)` / `hasKey(ref)` over IPC.
- The renderer never holds a key after the form submits.
- Keep env-var overrides (`LLMX_KEY_<REF>`) for convenience.
- Remove `apiKey` from `CH` and from the `sendPrompt` payload.

## Pillar 3 — Python (`main.js`, `synthesize.py`)

3.1 **Model reload every call (~15 s):** run Python as a long-lived worker started on
first use and kept warm. Talk to it over a line protocol: send
`{"id":..., "sources":[...]}\n` on stdin, read `{"id":..., "delta":"..."}` /
`{"id":..., "done":true}` lines back. Only the first turn pays the 15 s cost. Kill it in
`before-quit`.

3.2 **Hardcoded paths** (`main.js:8-9`): move `PYTHON_EXE` and the script path into
settings, and copy `synthesize.py` into this repo (e.g. `python/`). When the executable is
missing, hide the "Local GPU" engine option instead of failing at send time. This is
required for the Phase 4 `.exe`.

3.3 **Unlabeled sources:** the synthesis prompt labels sources `SOURCE 1..n`
(`main.js:181`), with no model names. Pass `{id, name, text}` so the synthesis can name
where disagreements come from.

## Pillar 4 — Branch-ready state (`index.html`)

You don't persist anything yet, so **there is no migration cost if the tree goes in
before localStorage persistence does**. Do it in that order.
```js
const convo = { version: 1, nodes: {}, rootIds: [], activeLeafId: null };
// node: { id, parentId, childIds:[], prompt, engine, replies:{[model]:{text,status,ms}},
//         order:[...], hybrid:{text,status,sources}, createdAt }
function activePath() {
  const path = []; for (let id = convo.activeLeafId; id; id = convo.nodes[id].parentId)
    path.unshift(convo.nodes[id]);
  return path;                      // render this instead of `turns`
}
function addTurn(parentId, prompt) {
  const n = { id: crypto.randomUUID(), parentId, childIds: [], prompt, replies: {}, order: [] };
  convo.nodes[n.id] = n;
  parentId ? convo.nodes[parentId].childIds.push(n.id) : convo.rootIds.push(n.id);
  convo.activeLeafId = n.id; return n;
}
```
- `t.n` → the node's index in `activePath()` (display only). `openState` keys → `node.id`.
- **Edit a past prompt** = `addTurn(oldNode.parentId, newPrompt)`.
  **Compare siblings** = render `convo.nodes[parentId].childIds` side by side.
- History depth = the last `d` nodes of `activePath()`.
- `order` stays per node, so drag-reorder of reply cards is just `node.order` splices.
- **Persistence:** scraped replies will outgrow localStorage's ~5 MB limit quickly. In
  Electron, save `convo` to `userData/conversations/<id>.json` over IPC. In the demo, use
  IndexedDB or localStorage. Put both behind one `store.save()` / `store.load()`.

## Pillar 5 — Fault tolerance

- `runConcurrent` + `Promise.allSettled` (`main.js:76-88`) is correct, and errors are
  per-provider. Good.
- The gaps are timeouts (B4, B3), Python errors (B5), and the renderer ignoring `status`
  (B8).
- Show `error` / `partial` states on cards with a per-card retry (re-run one provider into
  the same node). That also gives the dead Retry button a job.

## Pillar 6 — Anime.js v4 and DOM rendering

6.1 **Full re-renders will undo animations:**
- `renderLeft()` clears `#llmList` on every master-slider tick (`index.html:807`), lock,
  prefix change, and row click.
- `renderConv()` clears the whole conversation on every reply and history-slider move
  (`index.html:882, 1065, 1292`).

Animations bound to those nodes get discarded mid-flight, and entry animations would
replay on every keystroke.

**Fix (prerequisite for animations):** keyed rendering. Keep `Map(id → element)`, create
each row or turn once, and update its fields in place. Only new nodes get an enter
animation.
```js
const rowEls = new Map();
function renderLeft() {
  const list = document.getElementById('llmList');
  CH.forEach(ch => {
    let row = rowEls.get(ch.id);
    if (!row) { row = buildRow(ch); rowEls.set(ch.id, row); animate(row, { opacity: [0, 1], y: [8, 0], duration: 250 }); }
    updateRow(row, ch);            // checkbox, slider value, heat vars, lock icon
    list.appendChild(row);         // re-append = reorder without recreating
  });
}
```

6.2 **Loading Anime.js:** it isn't installed, and there's no bundler.
1. `npm i animejs`.
2. Copy its ESM build into `vendor/anime.esm.js`. Check the exact `dist/` path after
   install; I haven't verified it.
3. Map it with `<script type="importmap">{"imports":{"animejs":"./vendor/anime.esm.js"}}</script>`.

Switching the main script to `type="module"` makes its functions module-scoped:
- `onclick="clearChat()"` still works, because it's assigned to `window`.
- Any new inline `onclick=` will not. Use `addEventListener` instead.

Use the same vendored file for the GitHub Pages demo, so no CDN is needed and it works
offline in Electron.

6.3 **Scopes:** wrap each component's animations in `createScope({ root })` and call
`scope.revert()` before tearing that component down (clear chat, switch branch, switch
tab).

6.4 **Performance:**
- Animate `transform` and `opacity` only.
- For the collapsible sidebar, animate a `translateX` on the panel, then commit the grid
  column width once in `onComplete`. Don't animate `width` or `grid-template-columns`
  per frame.
- For pulsing heat borders, animate `opacity` on a `::after` glow layer (or a CSS custom
  property via CSS), not `box-shadow` per frame.

6.5 **Matrix background:** draw it on one `<canvas>` with `requestAnimationFrame`, not as
DOM nodes animated by Anime.js. Start it on send and stop it on `hybrid-complete`. Honor
`prefers-reduced-motion`. Use Anime.js only to fade the canvas `opacity` in and out.

6.6 **Add a Content-Security-Policy** `<meta>` (Electron warns without one):
`default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:`.
Tighten `connect-src` later.

## Demo mode: one file, two transports

`demo/index.html` should stop being a fork. Use one `index.html` with a transport chosen
at startup:
```js
const transport = window.api            // Electron preload
  ?? (sessionKey() ? browserApiTransport : demoTransport);  // real API calls : simulated replies
```
- `demoTransport` replays canned replies through the same `onReply` / `onStream` /
  `onComplete` callbacks, so the UI code paths are identical.
- "Enter an API key to exit demo mode" switches to `browserApiTransport`, which calls the
  provider directly with the visitor's own key. Keep that key in `sessionStorage` by
  default.
- Check browser CORS support per provider before promising this: some APIs block direct
  browser calls. Scraping is Electron-only and stays hidden in the browser build.
- GitHub Pages can serve `index.html` from the repo root or a build step can copy it to
  `demo/`. Either way, keep one source.

## Suggested order

Everything below fits inside "Phase 3.5 first", but the state model has to come before
the animation work, because both rewrite `renderConv`.

1. **Bug sweep:** B1–B6 (small, mostly `main.js` and `scrapers.js`).
2. **Provider registry and key store** (Pillar 2). This unlocks "add a site / LLM".
3. **Tree state, `turnId`, and keyed rendering** (Pillar 4 + 6.1), then persistence.
4. **Anime.js, collapsible bars, matrix canvas** (6.2–6.5).
5. **Merge the demo into one file** (Demo section).
6. **Branching UI** (Phase 3) is then mostly view work on the existing tree.
7. **Warm Python worker and warm browser contexts** can go anywhere. They're independent.
