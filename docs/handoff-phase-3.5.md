# Handoff: Phase 3.5 Refactor (llm-explorer)

**For:** the coding LLM. **Owner:** firestarterpro. **Date:** 2026-10-19.
**Companion doc:** [phase-3.5-audit.md](phase-3.5-audit.md) has the reasoning and code snippets
behind each item. This doc gives the decisions and the task list. Where they disagree,
this doc wins.

## Rules for this work

- Single user for now. Don't build multi-user features.
- Keep the existing look ("keep our format"). Add to it; don't restyle it.
- Code snippets in your replies: 20 lines max. Don't paste whole files back.
- Don't commit unless the owner asks.
- Don't add stealth or bot-detection-evasion code. When a site walls you, the owner solves
  it by hand in Login Mode, or that provider switches to its API.

## Already done (don't redo)

The reviewer fixed these in `main.js` and tested them with a harness against fake Python
scripts and a fake hung endpoint:

- A missing Python or `synthesize.py` now shows "Local GPU synthesis is unavailable… switch
  to Cloud API" instead of crashing the main process.
- The Python process has a spawn `error` handler, a stdin `EPIPE` guard, and a 180 s kill
  timer. `hybrid-complete` is sent exactly once, and a non-zero exit code is reported.
- stdout is decoded as a UTF-8 stream, so emoji split across chunks no longer garble.
- `AbortSignal.timeout` on custom-model fetches (120 s) and the DeepSeek stream (180 s),
  with readable "timed out" errors.
- `app.on('before-quit')` kills every Python process still running.

The timeout constants are at the top of `main.js` (`PYTHON_TIMEOUT_MS`, etc.).

## Decisions made with the owner

| Topic | Decision |
|---|---|
| API keys | Encrypted with Electron `safeStorage`, kept in main only. No plain text file. The renderer never holds a key after the form submits. |
| Order of work | The conversation tree + `turnId` + keyed rendering come **before** Anime.js work. |
| Demo | One `index.html` for both app and demo. Stop maintaining `demo/index.html` as a fork. |
| Turn locking | A completed turn is locked: its prompt and replies don't change. Editing a past prompt creates a **new branch**. Exception: a reply slot in `error` / `partial` state can be retried in place. |
| Single source | If only one model replied, skip synthesis. Show its reply in the same hybrid card layout, labeled "Single source · {Model}", so every turn looks the same. |
| Prompt prefix | Prefix and heat are built from each model's **slider value** (see T6). |
| Source tags | Hidden internal tags `R1..Rn` per turn, mapped to provider ids. See T9. |
| Fidelity suffix | Per-model toggle button that adds a self-score instruction to that model's prompt. See T7. |
| Vault | All saved data goes in one folder, files named by date/time. The toolbar shows its size; clicking it opens the folder. See T12. |
| Instruction files | The owner's local coder will clean the stray backslashes (`\#`, `\*\*`) in `C:\llm\instructions\*.md`. **Not your task.** |

## Tasks (in order)

### T1. Bug sweep (`scrapers.js`, `main.js`)
- **B3 (response completion):** count the response elements before submitting, wait for a
  new one to appear, then wait until it stays stable. Add optional per-provider
  `doneSelector` and `timeoutMs` (default 180 s). Return `status: 'partial'` on timeout,
  never success.
- **B6 (wrong model field):** custom models need a separate `modelId` field. Send that as
  `model`, not the display name.
- **Launch flags:** remove `--no-sandbox` and the hardcoded `Chrome/120` user agent from
  `genericScrape`.
- **Same-profile collision:** Login Mode and scrapes must share one `getContext(id)`, so
  the same profile is never launched twice (audit 1.1–1.2).
- Delete the orphaned `user_data/` directory.

### T2. Provider registry (zero code edits to add a site or LLM)
- `providers.json` in the repo for built-ins. `userData/providers.json` for user-added
  ones, merged on top by `id`.
- Two kinds: `"scrape"` (url, inputSelector, submit, responseSelector, doneSelector,
  timeoutMs, `search: true` for Brave/Google-style rows) and `"api"` (endpoint, modelId,
  keyRef).
- Main exposes `api.getProviders()`, `api.addProvider(cfg)`, `api.removeProvider(id)`.
- The renderer builds `CH` from the registry, plus saved UI prefs (checked, value, locked,
  prefix, fidelity, order).
- One "➕ Add" modal (replacing the current `prompt()` chain) with two tabs: **Website**
  (selectors) and **API / Local** (endpoint, model ID, optional key).
- Dispatcher in main: `adapters[cfg.kind](cfg, prompt) → { id, status, text, ms }`.
  Scrapers no longer receive `event`.

### T3. Key store
- Generalize the existing DeepSeek `safeStorage` code into
  `keys: { [keyRef]: base64(enc) }` in `userData/settings.json`.
- IPC: `setKey(ref, key)` returns `{ ok }`, and `hasKey(ref)` returns a boolean. There is
  **no** getter to the renderer.
- Env-var override: `LLMX_KEY_<REF>`. DeepSeek keeps `DEEPSEEK_API_KEY`.
- Remove `apiKey` from `CH` and from the `sendPrompt` payload.

### T4. Conversation tree + `turnId`
- Replace `turns[]` with `convo = { version: 1, nodes, rootIds, activeLeafId }`. Node
  fields:
  `{ id, parentId, childIds, prompt, perModelPrompts, engine, replies: {[id]: {text, status, ms}}, order, sourceTags, hybrid: {text, status, log, score}, locked, createdAt }`.
- Render `activePath()`. The turn number shown = index in the path. Key `openState` by
  `node.id`.
- Every IPC message carries `turnId`, so handlers update `convo.nodes[turnId]`, never "the
  last turn".
- When a turn finishes, set `locked = true`. Editing a past prompt calls
  `addTurn(old.parentId, newPrompt)`. Retrying a failed slot re-runs that one provider into
  the same node.
- History depth = the last `d` nodes of `activePath()`.

### T5. Keyed rendering (prerequisite for animations)
- `renderLeft` / `renderConv` must stop clearing everything with `innerHTML = ''`.
- Keep `Map(id → element)`. Build each row or turn once, update its fields in place, and
  re-append to reorder.
- Streaming targets `[data-turn="<id>"] .hybrid-body[data-kind="hybrid"]` (this fixes
  B2). Single-model cards get `data-kind="reply"`.
- The master slider updates row values and heat in place without rebuilding rows.

### T6. Per-model prompt assembly (B7)
Built in the renderer at send time. Each model gets its own text, sent as
`perModelPrompts: { [id]: text }`:
```
[preset/custom prefix   — if the toolbar Prefix toggle is on]
[heat instruction       — from that model's slider value]
[history context        — last d turns of the active path]
<user prompt>
[fidelity suffix        — if that model's 🎯 toggle is on (T7)]
```
Heat bands (put the text in one constant so it's easy to tune):

| Slider | Instruction |
|---|---|
| 1–20 | Answer in 1–2 sentences. |
| 21–40 | Be brief; key points only. |
| 41–60 | (none) |
| 61–80 | Be detailed; include examples. |
| 81–100 | Be exhaustive: cover edge cases, examples, and caveats. |

- For `api` models, also map heat to `max_tokens` (e.g. `value × 40`, minimum 256).
- `search: true` rows (Brave/Google) have no slider. Send them the raw prompt plus the
  fidelity suffix only.
- Wire up the toolbar **✨ Prefix** toggle (it currently has no handler).

### T7. Fidelity suffix toggle (per model)
- Add a 🎯 toggle button to every model row, including search rows. Store it as
  `ch.fidelity`, default off.
- When on, append one shared suffix asking the model to end its reply with:
  ```
  SCORE: <0-10>/10
  REASON: <one sentence on confidence and sources>
  ```
- The existing `parseScore` / `stripScore` already read this format, so reuse them for the
  per-reply 🎯 percentages.

### T8. Synthesis pipeline (both engines)
- **Pass the original user question to the synthesizer.** Currently neither engine sees
  it.
- Both engines load the same instructions from `C:\llm\instructions\system_synthesizer.md`
  and `fidelity_clause.md` (make the path a setting). Delete the hardcoded DeepSeek prompt
  in `main.js`.
- Sources are sent as `{ tag, id, name, text }` (T9).
- **Single source:** skip synthesis and copy the reply into the hybrid card with the label
  "Single source · {Model}". Set `hybrid.status = 'single'`.
- **Fidelity Log parsing:** split the synthesis output at `### FIDELITY LOG`. The answer
  goes in `hybrid.text`; the log goes in `hybrid.log`, shown under the score bar.
- **Real score:** remove the hardcoded `score = 100`. Compute it from the log: sources
  with a "KEPT FROM Rn" entry are *used*, sources with none are *omitted* (dim their
  emoji). Use `(used / total) × 100`, lowered by 10 per item in CONFLICTS (minimum 0).
  Show the formula in the score tooltip.

### T9. Source tags
- Each turn assigns `R1..Rn` in `order` and stores `sourceTags: { R1: 'chatgpt', ... }`
  on the node. The UI never displays the tags; it shows emoji.
- The synthesizer sees `=== RESPONSE R1 — ChatGPT ===`. Numbers don't run out (this
  fixes the 26-letter limit in Python), and names let the Fidelity Log attribute
  conflicts.
- The globally unique key for a source is `node.id + '/' + tag`.

### T10. `synthesize.py` (lives at `C:\llm\src\`; copy it into this repo as `python/synthesize.py`)
1. **Keep the model loaded.** Make it a long-lived worker that loads the model once, then
   loops reading one JSON request per line from stdin:
   `{"id", "question", "sources":[{tag,name,text}]}`.
2. **Structured output.** Reply on stdout with one JSON object per line:
   `{"id","delta"}`, `{"id","done":true}`, `{"id","error"}`. Status messages ("Loading
   model…", dividers, "[Synthesis Complete]") go to stderr or `{"status":...}` lines,
   **never into the answer text**. Main parses the lines and forwards only `delta` as
   `hybrid-stream`.
3. **Turn off Qwen3 thinking** for synthesis (`/no_think` or the chat template's
   `enable_thinking=False`). Thinking tokens currently eat the 1500-token budget. As a
   backstop, remove `<think>…</think>` from the full text instead of checking per token.
4. Use the source labels from T9. Remove the `ABC…` label list.
5. Session transcripts are written to the vault (T12), not `C:\llm\outputs\sessions`.
   Main passes the vault path via an env var or argument.

Main side:
- Start the worker on first Local GPU send. Restart it if it dies.
- The per-request timeout stays at 180 s, but a timeout cancels that request without
  killing a healthy worker.
- `before-quit` already kills children through `activeChildren`; register the worker
  there.

### T11. Persistence
- Electron: `store.save()` / `store.load()` over IPC write the conversation as JSON to the
  vault (T12). Save at most once per second, and immediately on turn completion.
- Demo/browser: the same `store` interface, backed by IndexedDB.
- Restore the last conversation on launch.

### T12. Vault (autosave folder + toolbar size badge)
- **Folder:** `app.getPath('userData')/vault/`, with subfolders `conversations/` and
  `synthesis/`.
- **File names** use the conversation's creation time, which stays fixed for that
  conversation: `2026-10-19_153012_<shortId>.json`. Python synthesis transcripts are named
  the same way, with a `_synthesis.txt` suffix.
- **Toolbar badge:** a top-bar item like `💾 4.2 MB`, always visible, updated after each
  save. The size is computed recursively in main and sent via IPC (`vault:size`).
- **Click:** open the vault folder in File Explorer with Electron
  `shell.openPath(vaultDir)` (`vault:open` IPC).
- **Demo build:** the badge shows the browser storage size from
  `navigator.storage.estimate()`, and clicking it does nothing.

### T13. Anime.js v4 + UI overhaul
- `npm i animejs`. Copy its ESM build into `vendor/`, map it with
  `<script type="importmap">`, and make the main script `type="module"`. Replace inline
  `onclick=` attributes with `addEventListener`.
- Use v4 syntax only: `import { animate, createScope } from 'animejs'`. Each component
  gets its own scope; call `scope.revert()` before tearing that component down.
- Animate `transform` and `opacity` only.
  - **Collapsible bars:** `translateX` during the animation, then commit the grid column
    width once in `onComplete`.
  - **Heat pulse:** opacity on a `::after` glow layer.
- **Matrix background while thinking:** one `<canvas>` driven by `requestAnimationFrame`.
  Start it on send and stop it on the last `hybrid-complete`; fade it with Anime.js
  opacity. Respect `prefers-reduced-motion`.
- Add a Content-Security-Policy `<meta>` tag (see audit 6.6).
- Wire up or hide the remaining dead buttons: Retry (→ T4 slot retry), Sync, Hybrid, Free
  APIs, and the Branch pill (→ T14).

### T14. Branching UI (Phase 3)
- The Branch pill lists the siblings of the current turn and switches `activeLeafId`.
- An "Edit & fork" action on any locked turn's prompt card.
- Compare view: siblings side by side.
- Drag-and-drop for reply cards reorders `node.order`, but only on unlocked turns, or
  only as a view preference. **Ask the owner** which.

### T15. One `index.html` for app and demo
- Choose a transport at startup:
  `window.api ?? (sessionKey() ? browserApiTransport : demoTransport)`.
- `demoTransport` replays canned replies through the same callbacks.
- "Enter an API key" switches to `browserApiTransport` (the visitor's own key, kept in
  `sessionStorage`). Check each provider's CORS support first, and hide providers that
  block browser calls.
- Scrape providers and Login Mode are hidden outside Electron.
- GitHub Pages serves this same file. Retire `demo/index.html`.

### Independent (any time)
- **Warm Playwright contexts:** one persistent context per provider, a new page per query,
  idle eviction after 10 minutes, closed on quit (audit 1.1).
- **`HEADLESS`:** read it from settings. The Login Mode window is always headed.

## Done means
- Adding a website or API model needs no code edits: you add it through the modal or
  `providers.json`.
- Two quick sends never mix replies. A completed turn never changes except retrying a
  failed slot.
- No API key ever appears in renderer state, localStorage, or the IPC prompt payload.
- Local GPU synthesis pays the model-load cost once per app session. No Python process
  survives quitting.
- The app and the demo run from the same `index.html`.
- The vault badge shows the size, updates on autosave, and opens File Explorer on click.
