const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const scrapers = require('./scrapers');

const PYTHON_SCRIPT_PATH = 'C:\\llm\\src\\synthesize.py';
const PYTHON_EXE = 'C:\\llm\\ov_env\\Scripts\\python.exe';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
// deepseek-chat and deepseek-reasoner were scheduled for retirement on
// 2026-07-24; DeepSeek's docs name deepseek-flash as the current fast model.
// It thinks before answering by default, so synthesis turns thinking off.
const DEEPSEEK_MODEL = 'deepseek-flash';
// DeepSeek's web Search API: results without a browser or a CAPTCHA, billed to
// the same key as synthesis. It returns sources to synthesize, not an answer.
const DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';
// The Search API accepts 1-128 characters per query.
const SEARCH_QUERY_MAX_CHARS = 128;
const SEARCH_RESULT_COUNT = 5;

// Timeouts so one hung endpoint or process can't stall a whole turn.
const PYTHON_TIMEOUT_MS = 180000;
const CUSTOM_MODEL_TIMEOUT_MS = 120000;
const DEEPSEEK_TIMEOUT_MS = 180000;
const SEARCH_TIMEOUT_MS = 30000;

// Child processes still running, stopped on quit so none are left behind.
const activeChildren = new Set();

function describeFetchError(error, timeoutMs) {
  return error && error.name === 'TimeoutError'
    ? `Request timed out after ${timeoutMs / 1000}s.`
    : error.message;
}

// DeepSeek errors use the OpenAI shape { error: { message } }. The statuses a
// presenter can fix on the spot get a plain-language hint.
function describeDeepSeekHttpError(status, raw) {
  let detail = '';
  try {
    const parsed = JSON.parse(raw);
    detail = (parsed && parsed.error && parsed.error.message) || '';
  } catch {
    // Not JSON; fall back to the raw body.
  }
  detail = String(detail || raw || '').trim().slice(0, 300);
  const hint = {
    401: 'DeepSeek rejected the API key. Re-enter it in Settings.',
    402: 'The DeepSeek account balance is empty. Top it up at platform.deepseek.com.',
    429: 'DeepSeek rate limit reached. Wait a few seconds and resend.'
  }[status];
  return hint ? `${hint} (HTTP ${status})` : `HTTP ${status}: ${detail || 'request failed'}`;
}

// Every payload carries the renderer's turnId so a late reply or stream chunk
// is routed to the turn that asked for it, never "the last turn" (BUG B1).
function sendStream(event, turnId, chunk) {
  event.reply('hybrid-stream', { turnId, chunk });
}

// Status and provider-error lines use their own channel, so they can never be
// mistaken for, or leak into, the synthesized answer or its export. Playwright
// errors carry a multi-line call log; only the first line is kept.
function sendLog(event, turnId, message) {
  const line = String(message || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean);
  if (!line) return;
  event.reply('hybrid-log', { turnId, line: line.length > 300 ? `${line.slice(0, 299)}…` : line });
}

// `ok` says whether a synthesis was actually written; `used` / `requested`
// count the sources that returned usable text. The renderer scores the turn
// from these instead of assuming success.
function sendComplete(event, turnId, info = {}) {
  event.reply('hybrid-complete', { turnId, ...info });
}

// The renderer turns this into the "Local Engine Offline" troubleshooting
// modal instead of failing silently when OVMS cannot be reached.
function sendEngineError(event, turnId, message) {
  event.reply('engine-error', {
    turnId,
    message: message || 'The local OVMS engine is offline.'
  });
}

// --- PROVIDER REGISTRY -----------------------------------------------------
// Built-ins live in the repo's providers.json. Anything the user adds goes to
// userData/providers.json and is merged on top by id, so adding a site or an
// API model never requires a code edit.
const BUILTIN_PROVIDERS_PATH = path.join(__dirname, 'providers.json');
// Templates are installable presets. They live in the app bundle and are never
// edited; adding one copies it into userData/providers.json.
const TEMPLATES_PATH = path.join(__dirname, 'templates.json');
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function userProvidersPath() {
  return path.join(app.getPath('userData'), 'providers.json');
}

function readProviderFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.templates) ? parsed.templates
        : parsed && Array.isArray(parsed.providers) ? parsed.providers : [];
    return list.filter(item => item && typeof item === 'object' && item.id);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read ${filePath}:`, error.message);
    return [];
  }
}

function writeUserProviders(providers) {
  fs.mkdirSync(path.dirname(userProvidersPath()), { recursive: true });
  fs.writeFileSync(userProvidersPath(), JSON.stringify({ version: 1, providers }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}

// scrape -> Playwright, api -> OpenAI-compatible chat endpoint,
// search -> DeepSeek Search API (built in only).
function providerKind(value) {
  return value === 'api' || value === 'search' ? value : 'scrape';
}

function defaultEmoji(kind) {
  return { api: '🧩', search: '🔎' }[kind] || '🌐';
}

function normalizeProvider(raw, isUser) {
  const kind = providerKind(raw.kind);
  return {
    ...raw,
    id: String(raw.id).trim(),
    name: String(raw.name || raw.id).trim(),
    emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji : defaultEmoji(kind),
    kind,
    // Search rows (DeepSeek Search, Brave, Google) have no slider. JSON may set
    // it explicitly.
    isStatic: typeof raw.isStatic === 'boolean'
      ? raw.isStatic
      : kind === 'search' || (kind === 'scrape' && raw.search === true),
    isUser: !!isUser
  };
}

function loadProviders() {
  const merged = new Map();
  for (const raw of readProviderFile(BUILTIN_PROVIDERS_PATH)) {
    const provider = normalizeProvider(raw, false);
    merged.set(provider.id, provider);
  }
  for (const raw of readProviderFile(userProvidersPath())) {
    const provider = normalizeProvider(raw, true);
    merged.set(provider.id, provider); // user entries win by id
  }
  return [...merged.values()];
}

// Templates use the same shape as provider configs. `requiresKey` and
// `description` are picker metadata; addProvider drops them before writing.
function loadTemplates() {
  return readProviderFile(TEMPLATES_PATH).map(template => {
    const kind = template.kind === 'api' ? 'api' : 'scrape';
    return {
      ...template,
      id: String(template.id).trim(),
      name: String(template.name || template.id).trim(),
      emoji: typeof template.emoji === 'string' && template.emoji
        ? template.emoji
        : (kind === 'api' ? '🧩' : '🌐'),
      kind
    };
  });
}

function slugifyProviderId(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
}

function uniqueProviderId(base, taken) {
  const root = base || 'provider';
  let id = root;
  let suffix = 2;
  while (taken.has(id)) id = `${root}-${suffix++}`;
  return id;
}

function assertHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
  return url.toString();
}

// Builds a complete provider config. `base` is the existing config when a
// provider is being edited, so partial updates (e.g. name only) keep selectors,
// endpoints and other fields the renderer never displays.
function buildProviderConfig(input, base = {}) {
  if (!input || typeof input !== 'object') throw new Error('A provider configuration is required.');

  // A search provider stays a search provider: only its name and emoji can be
  // edited, and nothing else can be turned into one.
  const kind = base.kind === 'search'
    ? 'search'
    : input.kind === 'api' || input.kind === 'scrape'
      ? input.kind
      : (base.kind === 'api' ? 'api' : 'scrape');
  const name = String(input.name ?? base.name ?? '').trim();
  if (!name) throw new Error('Provider name is required.');

  const emoji = typeof input.emoji === 'string' ? input.emoji.trim() : '';
  const provider = {
    ...base,
    id: String(input.id ?? base.id ?? '').trim(),
    name,
    emoji: emoji || base.emoji || defaultEmoji(kind),
    kind
  };

  if (kind === 'search') {
    // The endpoint and the key are fixed in main (DEEPSEEK_SEARCH_URL, the
    // "deepseek" key), so no config field can redirect where the key goes.
    provider.isStatic = true;
    for (const key of ['url', 'inputSelector', 'responseSelector', 'submitAction', 'submitButton',
      'doneSelector', 'search', 'endpoint', 'modelId', 'keyRef', 'timeoutMs', 'forceTextBox']) {
      delete provider[key];
    }
  } else if (kind === 'api') {
    provider.endpoint = assertHttpUrl(input.endpoint ?? base.endpoint, 'Endpoint');
    provider.modelId = String(input.modelId ?? base.modelId ?? '').trim();
    if (!provider.modelId) throw new Error('Model ID is required for an API provider.');
    // Never trust a renderer-supplied keyRef. A crafted config such as
    // { endpoint: 'https://evil', keyRef: 'deepseek' } would otherwise send the
    // DeepSeek key to an attacker's endpoint. Provider keys are namespaced by
    // the id that main.js assigned, so one provider can only ever use its own.
    provider.keyRef = `provider:${provider.id}`;
    provider.isStatic = false;
    delete provider.url;
    delete provider.inputSelector;
    delete provider.responseSelector;
    delete provider.submitAction;
    delete provider.submitButton;
    delete provider.doneSelector;
    delete provider.search;
  } else {
    provider.url = assertHttpUrl(input.url ?? base.url, 'Provider URL');
    provider.inputSelector = String(input.inputSelector ?? base.inputSelector ?? '').trim();
    provider.responseSelector = String(input.responseSelector ?? base.responseSelector ?? '').trim();
    if (!provider.inputSelector || !provider.responseSelector) {
      throw new Error('Website providers need an input selector and a response selector.');
    }

    const submitAction = input.submitAction ?? base.submitAction;
    provider.submitAction = submitAction === 'button' ? 'button' : 'enter';
    provider.submitButton = String(input.submitButton ?? base.submitButton ?? '').trim();
    if (provider.submitAction === 'button' && !provider.submitButton) {
      throw new Error('A submit button selector is required when submitAction is "button".');
    }

    provider.search = input.search !== undefined ? !!input.search : !!base.search;
    provider.isStatic = typeof input.isStatic === 'boolean'
      ? input.isStatic
      : (typeof base.isStatic === 'boolean' ? base.isStatic : provider.search);
    provider.doneSelector = input.doneSelector !== undefined
      ? (String(input.doneSelector || '').trim() || null)
      : (base.doneSelector || null);
    const timeout = Number(input.timeoutMs ?? base.timeoutMs);
    provider.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 180000;
    delete provider.endpoint;
    delete provider.modelId;
    delete provider.keyRef;
  }

  // UI defaults can travel with the config so the first render looks right.
  for (const key of ['checked', 'value', 'prefixType', 'maxTokens', 'tps', 'ttft', 'fidelity']) {
    if (input[key] !== undefined) provider[key] = input[key];
  }

  // isUser is derived by loadProviders(); never persist it.
  delete provider.isUser;
  // Keys never go in a provider file; they belong in the encrypted store.
  delete provider.apiKey;
  // Template-picker metadata is not part of a provider config.
  delete provider.requiresKey;
  delete provider.description;

  return provider;
}

function addProvider(input) {
  if (!input || typeof input !== 'object') throw new Error('A provider configuration is required.');
  if (input.kind === 'search') throw new Error('DeepSeek Search is built in and cannot be added again.');

  const userList = readProviderFile(userProvidersPath());
  const builtinIds = new Set(readProviderFile(BUILTIN_PROVIDERS_PATH).map(item => String(item.id)));
  const userIds = new Set(userList.map(item => String(item.id)));

  const name = String(input.name || '').trim();
  if (!name) throw new Error('Provider name is required.');

  let id;
  const requestedId = String(input.id || '').trim();
  if (requestedId) {
    if (!PROVIDER_ID_RE.test(requestedId)) {
      throw new Error('Provider id may only contain letters, numbers, dots, dashes, and underscores.');
    }
    if (builtinIds.has(requestedId)) {
      throw new Error(`"${requestedId}" is a built-in provider id; choose another id.`);
    }
    id = requestedId;
  } else {
    id = uniqueProviderId(slugifyProviderId(name), new Set([...builtinIds, ...userIds]));
  }

  const provider = buildProviderConfig({ ...input, id }, {});

  writeUserProviders([...userList.filter(item => String(item.id) !== id), provider]);
  return { ok: true, provider: normalizeProvider(provider, true) };
}

// Editing a built-in writes a user-level override with the same id; loadProviders
// merges user entries on top of the read-only built-ins. Removing that override
// later restores the shipped default.
function editProvider(id, input) {
  const targetId = String(id || '').trim();
  if (!targetId) throw new Error('A provider id is required.');
  if (!input || typeof input !== 'object') throw new Error('A provider configuration is required.');

  const existing = loadProviders().find(provider => provider.id === targetId);
  if (!existing) throw new Error(`Unknown provider "${targetId}".`);

  const userList = readProviderFile(userProvidersPath());
  const provider = buildProviderConfig({ ...input, id: targetId }, existing);

  writeUserProviders([...userList.filter(item => String(item.id) !== targetId), provider]);

  // The API key arrives with the edit form but still belongs only in the
  // encrypted store. An empty value means "keep the current key".
  let keyError = null;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (provider.kind === 'api' && apiKey) {
    try {
      const saved = setKey(provider.keyRef, apiKey);
      if (!saved?.ok) keyError = saved?.error || 'The API key could not be saved.';
    } catch (error) {
      keyError = error.message;
    }
  }

  return { ok: true, provider: normalizeProvider(provider, true), keyError };
}

function removeProvider(id) {
  const targetId = String(id || '');
  const userList = readProviderFile(userProvidersPath());
  const target = userList.find(item => String(item.id) === targetId);
  if (!target) return { ok: false, error: 'That provider is built-in or does not exist.' };

  writeUserProviders(userList.filter(item => String(item.id) !== targetId));

  // Auto-generated refs belong to this provider; don't leave an orphan key.
  const keyRef = String(target.keyRef || '');
  if (keyRef.startsWith('provider:')) removeKey(keyRef);
  return { ok: true };
}

// --- SECURE KEY STORE ------------------------------------------------------
// Keys are encrypted with Electron safeStorage (DPAPI on Windows) and kept in
// userData/settings.json under keys[ref]. The renderer can write a key and ask
// whether one exists; there is deliberately no getter over IPC.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}

function keyEnvName(ref) {
  return `LLMX_KEY_${String(ref).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function keyFromEnvironment(ref) {
  const value = process.env[keyEnvName(ref)];
  if (value && value.trim()) return value.trim();
  // DeepSeek keeps its Phase 1 environment name.
  if (String(ref).toLowerCase() === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  return '';
}

function encryptedKeyFor(settings, ref) {
  if (settings.keys && typeof settings.keys === 'object' && settings.keys[ref]) {
    return settings.keys[ref];
  }
  // Read the pre-registry DeepSeek field until the next setKey migrates it.
  if (ref === 'deepseek' && settings.deepseekApiKeyEnc) return settings.deepseekApiKeyEnc;
  return '';
}

function decryptKey(encoded, ref) {
  if (!encoded || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64')).trim();
  } catch (error) {
    console.error(`Could not decrypt the stored key for "${ref}":`, error.message);
    return '';
  }
}

function getKey(ref) {
  const envKey = keyFromEnvironment(ref);
  if (envKey) return envKey;
  return decryptKey(encryptedKeyFor(loadSettings(), ref), ref);
}

function hasKey(ref) {
  return !!getKey(ref);
}

function keySource(ref) {
  if (keyFromEnvironment(ref)) return 'environment';
  return encryptedKeyFor(loadSettings(), ref) ? 'settings' : 'none';
}

function setKey(ref, key) {
  const name = String(ref || '').trim();
  if (!name) return { ok: false, error: 'A key reference is required.' };
  const value = String(key || '').trim();
  if (!value) return { ok: false, error: 'API key cannot be empty.' };

  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: `OS encryption is unavailable. Set ${keyEnvName(name)} in the environment instead.`
    };
  }

  const settings = loadSettings();
  if (!settings.keys || typeof settings.keys !== 'object' || Array.isArray(settings.keys)) {
    settings.keys = {};
  }
  settings.keys[name] = safeStorage.encryptString(value).toString('base64');
  if (name === 'deepseek') delete settings.deepseekApiKeyEnc;
  saveSettings(settings);
  return { ok: true };
}

function removeKey(ref) {
  const settings = loadSettings();
  if (!settings.keys || !settings.keys[ref]) return;
  delete settings.keys[ref];
  saveSettings(settings);
}

// --- APP PREFERENCES ---------------------------------------------------------
// Non-secret switches kept in settings.json next to the encrypted keys. Only
// the names listed here can be read or written over IPC.
const APP_PREF_DEFAULTS = {
  // Settings > "Show browsers during scraping (Debug)". Off: scrapes run in an
  // off-screen window. Login Mode is always on-screen.
  showBrowsers: false
};

function getAppPrefs() {
  const stored = loadSettings().prefs;
  const prefs = { ...APP_PREF_DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const name of Object.keys(APP_PREF_DEFAULTS)) {
      if (typeof stored[name] === typeof APP_PREF_DEFAULTS[name]) prefs[name] = stored[name];
    }
  }
  return prefs;
}

function setAppPref(name, value) {
  if (!Object.prototype.hasOwnProperty.call(APP_PREF_DEFAULTS, name)) {
    return { ok: false, error: `Unknown preference "${name}".` };
  }
  if (typeof value !== typeof APP_PREF_DEFAULTS[name]) {
    return { ok: false, error: `Invalid value for "${name}".` };
  }
  const settings = loadSettings();
  const prefs = settings.prefs && typeof settings.prefs === 'object' && !Array.isArray(settings.prefs)
    ? settings.prefs
    : {};
  settings.prefs = { ...prefs, [name]: value };
  saveSettings(settings);
  return { ok: true, prefs: getAppPrefs() };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // This window is a local app shell, not a browser. A dropped file or a
  // target="_blank" link must not replace index.html, because the resulting
  // page would inherit the preload bridge (window.api).
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile('index.html');
}

// --- QUEUE SYSTEM (Max 3 concurrent browsers to prevent RAM crash) ---
async function runConcurrent(tasks, limit = 3) {
  const executing = new Set();
  const all = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    executing.add(p);
    all.push(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(all);
}

// --- PYTHON SYNTHESIZER ---
// sources: [{ name, text }]. complete(ok) reports the outcome exactly once.
function runSynthesizer(sources, event, turnId, complete) {
  if (sources.length === 0) {
    sendLog(event, turnId, 'No responses were collected. Cannot synthesize.');
    complete(false);
    return;
  }

  if (!fs.existsSync(PYTHON_EXE) || !fs.existsSync(PYTHON_SCRIPT_PATH)) {
    const message = 'Local GPU synthesis is unavailable: Python or synthesize.py was not found.';
    sendLog(event, turnId, `${message} Switch the engine to Cloud API.`);
    sendEngineError(event, turnId, message);
    complete(false);
    return;
  }

  console.log(`Passing ${sources.length} responses to OpenVINO...`);
  sendLog(event, turnId, 'Running local OpenVINO synthesis...');

  // synthesize.py still reads bare response texts on stdin.
  const inputData = sources.map(source => source.text).join('\n---END---\n');
  const pyProcess = spawn(PYTHON_EXE, [PYTHON_SCRIPT_PATH], { windowsHide: true });
  activeChildren.add(pyProcess);

  // 'error' and 'close' can both fire, so only report completion once.
  let finished = false;
  let sawOutput = false;
  let killTimer = null;
  const finish = (message, ok = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    activeChildren.delete(pyProcess);
    if (message) sendLog(event, turnId, message);
    complete(ok);
  };

  killTimer = setTimeout(() => {
    pyProcess.kill();
    finish(`Local synthesis timed out after ${PYTHON_TIMEOUT_MS / 1000}s and was stopped.`);
  }, PYTHON_TIMEOUT_MS);

  pyProcess.on('error', (error) => {
    console.error('Python failed to start:', error.message);
    sendEngineError(event, turnId, `Local synthesis failed to start: ${error.message}`);
    finish(`Local synthesis failed to start: ${error.message}`);
  });

  // Python exiting early would otherwise raise an unhandled EPIPE here.
  pyProcess.stdin.on('error', (error) => console.error('Python stdin error:', error.message));
  pyProcess.stdin.write(inputData);
  pyProcess.stdin.end();

  // Decode as a stream so multi-byte characters split across chunks stay intact.
  pyProcess.stdout.setEncoding('utf8');
  pyProcess.stdout.on('data', (data) => {
    if (finished) return;
    if (String(data).trim()) sawOutput = true;
    sendStream(event, turnId, data);
  });

  // OVMS runs as a separate server, so a refused/lost connection surfaces on
  // stderr. Keep the tail so the modal can show the real reason.
  let stderrTail = '';
  pyProcess.stderr.on('data', (data) => {
    const text = data.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    console.error(`Python Error: ${text}`);
  });

  pyProcess.on('close', (code) => {
    if (code && /connection|refused|econn|10061|timed out|timeout|offline|unreachable|failed to connect/i.test(stderrTail)) {
      const detail = stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() || 'connection refused';
      sendEngineError(event, turnId, `The local OVMS engine could not be reached: ${detail}`);
    }
    finish(code ? `Local synthesis exited with code ${code}.` : null, !code && sawOutput);
  });
}

// --- CUSTOM API MODELS ----------------------------------------------------
// API providers bypass Playwright and call their configured endpoint directly.
// The key is read from the encrypted store at call time, never from the renderer.
// Returns { id, status, text, ms }; the dispatcher emits IPC.
async function runCustomModel(model, promptText) {
  const startedAt = Date.now();
  try {
    const modelId = String(model.modelId || '').trim();
    if (!modelId) throw new Error('No model ID configured for this custom LLM.');

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = model.keyRef ? getKey(model.keyRef) : '';
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(model.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: promptText }],
        stream: false
      }),
      signal: AbortSignal.timeout(CUSTOM_MODEL_TIMEOUT_MS)
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`);
    }

    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Some custom endpoints return plain text instead of OpenAI-style JSON.
    }

    const text = extractModelText(data).trim();
    if (!text) throw new Error('The endpoint returned no text.');

    return { id: model.id, status: 'success', text, ms: Date.now() - startedAt };
  } catch (error) {
    const message = describeFetchError(error, CUSTOM_MODEL_TIMEOUT_MS);
    console.error(`Custom model "${model.name}" error:`, message);
    return {
      id: model.id,
      status: 'error',
      text: `Error: ${message}`,
      ms: Date.now() - startedAt
    };
  }
}

function extractModelText(data) {
  if (typeof data === 'string') return data;
  const choice = data && data.choices && data.choices[0];
  const content = choice && (
    (choice.message && choice.message.content) ||
    choice.text
  ) || (data && (data.response || data.output_text || data.content));
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : (part && part.text) || '').join('');
  }
  return typeof content === 'string' ? content : '';
}

// --- DEEPSEEK SEARCH -------------------------------------------------------
// The query is the user's own question, never the per-model prompt (prefix +
// history), because the Search API takes 1-128 characters. Longer questions are
// cut at a word boundary. Counting code points keeps emoji intact.
function searchQueryFrom(question) {
  const chars = Array.from(String(question || '').replace(/\s+/g, ' ').trim());
  if (chars.length <= SEARCH_QUERY_MAX_CHARS) return chars.join('');
  const cut = chars.slice(0, SEARCH_QUERY_MAX_CHARS).join('');
  const space = cut.lastIndexOf(' ');
  return (space >= cut.length / 2 ? cut.slice(0, space) : cut).trim();
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// `summary` (600-800 characters) is the field DeepSeek writes for model
// consumption; full page content (need_content) would bloat the synthesis.
function formatSearchResults(query, results) {
  const lines = [`Web search results for: ${query}`];
  results.forEach((item, index) => {
    const site = item.site_name || hostOf(item.url) || 'unknown site';
    const date = typeof item.date === 'string' && item.date ? ` (${item.date.slice(0, 10)})` : '';
    lines.push(
      '',
      `${index + 1}. ${String(item.title || 'Untitled').trim()} - ${site}${date}`,
      String(item.url || '').trim(),
      String(item.summary || item.snippet || '').trim()
    );
  });
  return lines.join('\n').trim();
}

// Adapter for kind "search". The endpoint and key are fixed here, never read
// from a provider config. Returns { id, status, text, ms, usable? }.
async function runDeepSeekSearch(config, question) {
  const startedAt = Date.now();
  const fail = text => ({ id: config.id, status: 'error', text, ms: Date.now() - startedAt });

  const query = searchQueryFrom(question);
  if (!query) return fail('Error: there is no question to search for.');

  const apiKey = getKey('deepseek');
  if (!apiKey) return fail('Error: the DeepSeek API key is not configured. Add it in Settings.');

  try {
    let response;
    for (let attempt = 1; attempt <= 2; attempt++) {
      response = await fetch(DEEPSEEK_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ query, count: SEARCH_RESULT_COUNT, need_content: false }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      });
      // DeepSeek documents 408, 429 and 5xx as worth one retry.
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!transient || attempt === 2) break;
      await response.text().catch(() => '');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const raw = await response.text();
    if (!response.ok) throw new Error(describeDeepSeekHttpError(response.status, raw));

    const data = JSON.parse(raw);
    const results = (Array.isArray(data && data.results) ? data.results : [])
      .filter(item => item && (item.summary || item.snippet))
      .sort((a, b) => (Number(b.rerank_score) || 0) - (Number(a.rerank_score) || 0))
      .slice(0, SEARCH_RESULT_COUNT);

    if (!results.length) {
      // Empty results are not billed and leave nothing to synthesize.
      return {
        id: config.id,
        status: 'partial',
        text: `No web results found for "${query}".`,
        ms: Date.now() - startedAt,
        usable: false
      };
    }

    return {
      id: config.id,
      status: 'success',
      text: formatSearchResults(query, results),
      ms: Date.now() - startedAt
    };
  } catch (error) {
    const message = describeFetchError(error, SEARCH_TIMEOUT_MS);
    console.error('DeepSeek Search error:', message);
    return fail(`Error: ${message}`);
  }
}

// --- DEEPSEEK CLOUD SYNTHESIZER ------------------------------------------
// sources: [{ name, text }]. Names let the synthesis say where a claim or a
// disagreement comes from.
function buildSynthesisPrompt(question, sources) {
  return [
    'You are a multi-model synthesis engine. Merge the source responses below into one',
    'coherent answer. Preserve consensus, note meaningful disagreements, remove repetition,',
    'and do not invent facts that are absent from the sources. A source may be a list of',
    'web search results: treat it as evidence and cite the URLs you rely on.',
    'Write plain text. Short paragraphs and simple "-" bullets are fine; do not use',
    'markdown headers, bold, tables or code blocks.',
    '',
    `The user asked: ${String(question || '').trim() || '(no question provided)'}.`,
    'Here are the responses:',
    '',
    ...sources.map((source, index) => `--- SOURCE ${index + 1}: ${source.name} ---\n${source.text}`)
  ].join('\n');
}

// complete(ok) is called exactly once; ok means a full synthesis was streamed.
async function runDeepSeekSynthesis(sources, promptText, event, turnId, complete) {
  if (sources.length === 0) {
    sendLog(event, turnId, 'No responses were collected. Cannot synthesize.');
    complete(false);
    return;
  }

  const apiKey = getKey('deepseek');
  if (!apiKey) {
    sendLog(event, turnId, 'DeepSeek API key is not configured. Click Settings or set DEEPSEEK_API_KEY.');
    complete(false);
    return;
  }

  sendLog(event, turnId, 'Cloud API synthesis via DeepSeek...');

  let sawContent = false;
  let failed = false;
  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: buildSynthesisPrompt(promptText, sources) },
          { role: 'user', content: 'Return the consolidated synthesis now.' }
        ],
        stream: true,
        // deepseek-flash reasons before answering unless told not to; the
        // sources already carry the facts, so start streaming the answer.
        thinking: { type: 'disabled' },
        temperature: 0.3
      }),
      // Covers the whole streamed body, not just the first byte.
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(describeDeepSeekHttpError(response.status, detail));
    }

    if (!response.body) {
      const data = await response.json();
      const text = extractModelText(data);
      if (!text) throw new Error('DeepSeek returned no text.');
      sawContent = true;
      sendStream(event, turnId, text);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        finished = true;
        return;
      }
      try {
        const data = JSON.parse(payload);
        const delta = data.choices && data.choices[0] &&
          data.choices[0].delta && data.choices[0].delta.content;
        if (delta) {
          sawContent = true;
          sendStream(event, turnId, delta);
        }
      } catch {
        // Ignore keep-alives or partial/non-JSON SSE lines.
      }
    };

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }

    buffer += decoder.decode();
    if (!finished && buffer.trim()) consumeLine(buffer);
    if (!sawContent) throw new Error('DeepSeek returned an empty stream.');
  } catch (error) {
    failed = true;
    const message = describeFetchError(error, DEEPSEEK_TIMEOUT_MS);
    console.error('DeepSeek synthesis error:', message);
    sendLog(event, turnId, `DeepSeek API error: ${message}`);
  } finally {
    complete(sawContent && !failed);
  }
}

function runSynthesis(sources, promptText, event, engine, turnId, complete) {
  const requested = String(engine || '').trim().toLowerCase();
  // An absent engine means the out-of-the-box Cloud default, matching the
  // renderer and the user-prompt handler.
  const useCloud = requested ? requested.includes('cloud') : true;
  return useCloud
    ? runDeepSeekSynthesis(sources, promptText, event, turnId, complete)
    // The local Python script still takes a bare response list on stdin, so the
    // question is only added on the Cloud path until synthesize.py accepts it.
    : runSynthesizer(sources, event, turnId, complete);
}

// Every adapter has the same shape:
// (config, shapedPrompt, question) -> { id, status, text, ms, usable? }.
// Search gets the user's own question; the others get the per-model prompt.
// Adapters never touch IPC; the dispatcher owns that. New kinds are one entry
// here, not edits to the user-prompt handler.
const providerAdapters = {
  scrape: (config, promptText) => scrapers.scrape(config, promptText, { showBrowser: getAppPrefs().showBrowsers }),
  api: (config, promptText) => runCustomModel(config, promptText),
  search: (config, promptText, question) => runDeepSeekSearch(config, question)
};

function normalizeProviderResult(config, raw) {
  const result = raw && typeof raw === 'object'
    ? raw
    : { id: config.id, status: raw ? 'success' : 'error', text: typeof raw === 'string' ? raw : '', ms: 0 };

  const status = ['success', 'partial', 'error'].includes(result.status) ? result.status : 'error';
  const rawText = typeof result.text === 'string' ? result.text : '';
  let text = rawText;

  // A partial result with no text means the reply element never appeared.
  if (!text && status !== 'success') {
    const seconds = Math.max(1, Math.round((Number(result.ms) || 0) / 1000));
    text = status === 'error'
      ? 'Error: the provider returned no text.'
      : `Partial response: no reply appeared after ${seconds}s.`;
  }

  return {
    id: result.id || config.id,
    status,
    text,
    ms: Number(result.ms) || 0,
    // Only real answer text reaches synthesis: never an error, the placeholder
    // above, or a result its adapter marked unusable (e.g. zero search hits).
    usable: status !== 'error' && result.usable !== false && !!rawText.trim()
  };
}

// Dispatcher: call the adapter, normalize what it returns, then emit IPC. Success
// text goes to the model's own card; non-success results also reach the hybrid log.
async function runProvider(config, promptText, question, event, turnId) {
  const adapter = providerAdapters[config.kind] || providerAdapters.scrape;
  let result;

  try {
    result = normalizeProviderResult(config, await adapter(config, promptText, question));
  } catch (error) {
    result = normalizeProviderResult(config, {
      id: config.id,
      status: 'error',
      text: `Error: ${error.message}`,
      ms: 0
    });
  }

  event.reply('reply-received', {
    turnId,
    model: result.id,
    text: result.text,
    status: result.status,
    ms: result.ms
  });
  if (result.status !== 'success') {
    sendLog(event, turnId, `${config.name}: ${result.text}`);
  }

  return { ...result, name: config.name };
}

app.whenReady().then(() => {
  createWindow();

  // 1. Handle Chat Prompts
  // payload: { turnId, promptText, activeModels, engine, perModelPrompts }.
  // Configs, and any API keys, are resolved in main from the registry.
  ipcMain.on('user-prompt', async (event, payload = {}) => {
    // Cloud is the out-of-the-box engine: Local GPU needs a separate Python
    // environment that a stakeholder's machine will not have.
    const {
      turnId,
      promptText = '',
      activeModels = [],
      engine = 'Cloud',
      perModelPrompts = null
    } = payload || {};

    // The renderer shapes one prompt per model (prefix + history + question).
    // Anything malformed falls back to the shared prompt.
    const modelPromptById = perModelPrompts && typeof perModelPrompts === 'object' && !Array.isArray(perModelPrompts)
      ? perModelPrompts
      : {};

    const promptForModel = (id) => {
      const shaped = modelPromptById[id];
      return typeof shaped === 'string' && shaped.trim() ? shaped : promptText;
    };

    // Without an id the renderer cannot route the replies, so refuse rather
    // than fall back to "the last turn".
    if (!turnId) {
      console.warn('Ignoring a prompt without a turnId.');
      return;
    }

    if (!Array.isArray(activeModels) || activeModels.length === 0) {
      sendLog(event, turnId, 'Please select at least one model.');
      sendComplete(event, turnId, { ok: false, used: 0, requested: 0 });
      return;
    }

    const byId = new Map(loadProviders().map(provider => [provider.id, provider]));
    const loadingText = { search: 'Searching the web...', api: 'Waiting for the API...' };

    // Each id is dispatched through the registry: scrape -> Playwright,
    // api -> fetch, search -> DeepSeek Search.
    const tasks = activeModels
      .map(id => {
        const config = byId.get(String(id));
        if (!config) {
          event.reply('reply-received', {
            turnId,
            model: id,
            text: `Error: unknown model "${id}"`,
            status: 'error',
            ms: 0
          });
          return null;
        }
        // Set UI to loading
        event.reply('reply-received', {
          turnId,
          model: config.id,
          text: loadingText[config.kind] || 'Scraping...',
          status: 'loading',
          ms: 0
        });
        return () => runProvider(config, promptForModel(config.id), promptText, event, turnId);
      })
      .filter(Boolean);

    // Run max 3 at a time
    const results = await runConcurrent(tasks, 3);

    // Synthesis gets usable answer text only, labelled with its source's name.
    // Errors, timeouts and empty partials stay out.
    const sources = results
      .filter(r => r.status === 'fulfilled' && r.value && r.value.usable)
      .map(r => ({ name: r.value.name, text: r.value.text }));

    const complete = ok => sendComplete(event, turnId, {
      ok: !!ok,
      used: sources.length,
      requested: activeModels.length
    });

    // A connection error thrown by the local engine must surface as a modal,
    // not as a silently stalled turn.
    try {
      runSynthesis(sources, promptText, event, engine, turnId, complete);
    } catch (error) {
      console.error('Synthesis failed:', error.message);
      sendLog(event, turnId, `Synthesis failed: ${error.message}`);
      sendEngineError(event, turnId, error.message);
      complete(false);
    }
  });

  // 2. Provider registry. User entries live in userData/providers.json.
  ipcMain.handle('providers:list', () => loadProviders());

  // Installable presets from the read-only templates.json in the app bundle.
  ipcMain.handle('templates:list', () => loadTemplates());

  ipcMain.handle('providers:add', (event, cfg) => {
    try {
      return addProvider(cfg);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('providers:remove', (event, id) => {
    try {
      return removeProvider(id);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Editing works for built-ins too: it writes a userData override that wins
  // over providers.json without touching the read-only app bundle.
  ipcMain.handle('providers:edit', (event, id, cfg) => {
    try {
      return editProvider(id, cfg);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 3. Encrypted key store. No IPC path returns a key to the renderer.
  ipcMain.handle('keys:set', (event, ref, key) => {
    try {
      return setKey(ref, key);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('keys:has', (event, ref) => hasKey(ref));

  // Legacy DeepSeek handlers, now thin aliases over the generic store.
  ipcMain.handle('settings:deepseek-status', () => ({
    configured: hasKey('deepseek'),
    source: keySource('deepseek')
  }));

  ipcMain.handle('settings:set-deepseek-key', (event, key) => {
    try {
      return setKey('deepseek', key);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 4. Whether the Local GPU engine can run here. A stakeholder's machine has
  // no C:\llm Python environment, so the renderer hides the Local option.
  ipcMain.handle('engine:status', () => ({
    localAvailable: fs.existsSync(PYTHON_EXE)
  }));

  // Non-secret app preferences (whitelisted names only; see APP_PREF_DEFAULTS).
  ipcMain.handle('prefs:get', () => getAppPrefs());
  ipcMain.handle('prefs:set', (event, name, value) => {
    try {
      return setAppPref(String(name || ''), value);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Settings > Reset Onboarding. The renderer has already removed its
  // onboarding flag from localStorage; flush it to disk before restarting so
  // the relaunched app reads the cleared value. location.reload() can't be
  // used: the will-navigate guard in createWindow blocks it.
  ipcMain.handle('app:relaunch', (event) => {
    event.sender.session.flushStorageData();
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  // 5. Export the current turn as Markdown. The renderer sends the already
  // formatted text; main only owns the native save dialog and disk write.
  ipcMain.handle('export-conversation', async (event, text) => {
    const content = typeof text === 'string' ? text : '';
    if (!content.trim()) {
      return { ok: false, canceled: false, error: 'There is nothing to export.' };
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const options = {
      title: 'Export conversation',
      defaultPath: path.join(app.getPath('documents'), `llm-explorer-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    };

    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, content, 'utf8');
      return { ok: true, canceled: false, filePath: result.filePath };
    } catch (error) {
      console.error('Could not export the conversation:', error.message);
      return { ok: false, canceled: false, error: error.message };
    }
  });

  // 5. Handle Login Mode
  // Opens one headed persistent context per enabled website provider, then
  // waits for the user to close that window before moving to the next one.
  // Cookies/sessions are flushed to the profile directory when the window closes.
  ipcMain.on('login-mode', async (event, requestedIds) => {
    // An empty list (e.g. nothing ticked yet) falls back to the enabled
    // defaults, so Login Mode always has something useful to open.
    const wanted = Array.isArray(requestedIds) && requestedIds.length > 0
      ? new Set(requestedIds.map(id => String(id)))
      : null;

    const configs = loadProviders().filter(provider => {
      if (provider.kind !== 'scrape') return false;
      if (wanted) return wanted.has(provider.id);
      // No renderer payload (older preload): fall back to the enabled defaults.
      return provider.checked !== false;
    });

    if (configs.length === 0) {
      console.warn('Login Mode: no enabled website providers to open.');
      return;
    }

    console.log(`Starting Login Mode for ${configs.map(config => config.name).join(', ')}...`);

    // Sequentially open each website provider so RAM doesn't blow up.
    for (const config of configs) {
      const id = config.id;
      let context;
      try {
        // scrapers.js owns the profile path and launch options, so Login Mode
        // and scraping open the same persistent session per provider.
        context = await scrapers.launchContext(id, {
          viewport: { width: 1024, height: 768 },
          // Login Mode is for a person, so it is always on-screen even though
          // scrapes run hidden.
          visible: true
        });

        // Register the listener before navigating so a window closed while the
        // page is still loading can never leave this loop hanging.
        const closed = new Promise(resolve => context.once('close', resolve));
        const page = context.pages()[0] || await context.newPage();
        await page.goto(config.url, { timeout: 60000 }).catch(error => {
          console.warn(`Login Mode could not load ${config.name}:`, error.message);
        });

        console.log(`Log into ${config.name}, then close its window to save the session.`);
        await closed;
        console.log(`${config.name} session saved.`);
      } catch (error) {
        console.error(`Login failed for ${id}:`, error.message);
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop any synthesis still running and close every Playwright context, so no
// Python or chrome.exe process outlives the app. The quit is deferred until
// closeAll() resolves; app.exit() does not emit before-quit, so this cannot
// loop.
let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();

  for (const child of activeChildren) child.kill();
  activeChildren.clear();

  // A wedged browser launch must not make the app unquittable.
  await Promise.race([
    scrapers.closeAll(),
    new Promise(resolve => setTimeout(resolve, 5000))
  ]);
  app.exit(0);
});