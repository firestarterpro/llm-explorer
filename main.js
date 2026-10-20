const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const scrapers = require('./scrapers');

const PYTHON_SCRIPT_PATH = 'C:\\llm\\src\\synthesize.py';
const PYTHON_EXE = 'C:\\llm\\ov_env\\Scripts\\python.exe';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

// Timeouts so one hung endpoint or process can't stall a whole turn.
const PYTHON_TIMEOUT_MS = 180000;
const CUSTOM_MODEL_TIMEOUT_MS = 120000;
const DEEPSEEK_TIMEOUT_MS = 180000;

// Child processes still running, stopped on quit so none are left behind.
const activeChildren = new Set();

function describeFetchError(error, timeoutMs) {
  return error && error.name === 'TimeoutError'
    ? `Request timed out after ${timeoutMs / 1000}s.`
    : error.message;
}

// Every payload carries the renderer's turnId so a late reply or stream chunk
// is routed to the turn that asked for it, never "the last turn" (BUG B1).
function sendStream(event, turnId, chunk) {
  event.reply('hybrid-stream', { turnId, chunk });
}

function sendComplete(event, turnId) {
  event.reply('hybrid-complete', { turnId });
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

function normalizeProvider(raw, isUser) {
  const kind = raw.kind === 'api' ? 'api' : 'scrape';
  return {
    ...raw,
    id: String(raw.id).trim(),
    name: String(raw.name || raw.id).trim(),
    emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji : (kind === 'api' ? '🧩' : '🌐'),
    kind,
    // Search rows (Brave/Google) have no slider. JSON may set it explicitly.
    isStatic: typeof raw.isStatic === 'boolean' ? raw.isStatic : (kind === 'scrape' && raw.search === true),
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

  const kind = input.kind === 'api' || input.kind === 'scrape'
    ? input.kind
    : (base.kind === 'api' ? 'api' : 'scrape');
  const name = String(input.name ?? base.name ?? '').trim();
  if (!name) throw new Error('Provider name is required.');

  const emoji = typeof input.emoji === 'string' ? input.emoji.trim() : '';
  const provider = {
    ...base,
    id: String(input.id ?? base.id ?? '').trim(),
    name,
    emoji: emoji || base.emoji || (kind === 'api' ? '🧩' : '🌐'),
    kind
  };

  if (kind === 'api') {
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
function runSynthesizer(responses, event, turnId) {
  const validResponses = responses.filter(Boolean);
  if (validResponses.length === 0) {
    sendStream(event, turnId, '\n[No responses were scraped successfully. Cannot synthesize.]\n');
    sendComplete(event, turnId);
    return;
  }

  if (!fs.existsSync(PYTHON_EXE) || !fs.existsSync(PYTHON_SCRIPT_PATH)) {
    const message = 'Local GPU synthesis is unavailable: Python or synthesize.py was not found.';
    sendStream(event, turnId, `\n[${message} Switch the engine to Cloud API.]\n`);
    sendEngineError(event, turnId, message);
    sendComplete(event, turnId);
    return;
  }

  console.log(`Passing ${validResponses.length} responses to OpenVINO...`);
  sendStream(event, turnId, '\n[Running local OpenVINO synthesis...]\n');

  const inputData = validResponses.join('\n---END---\n');
  const pyProcess = spawn(PYTHON_EXE, [PYTHON_SCRIPT_PATH], { windowsHide: true });
  activeChildren.add(pyProcess);

  // 'error' and 'close' can both fire, so only report completion once.
  let finished = false;
  let killTimer = null;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    activeChildren.delete(pyProcess);
    if (message) sendStream(event, turnId, message);
    sendComplete(event, turnId);
  };

  killTimer = setTimeout(() => {
    pyProcess.kill();
    finish(`\n[Local synthesis timed out after ${PYTHON_TIMEOUT_MS / 1000}s and was stopped.]\n`);
  }, PYTHON_TIMEOUT_MS);

  pyProcess.on('error', (error) => {
    console.error('Python failed to start:', error.message);
    sendEngineError(event, turnId, `Local synthesis failed to start: ${error.message}`);
    finish(`\n[Local synthesis failed to start: ${error.message}]\n`);
  });

  // Python exiting early would otherwise raise an unhandled EPIPE here.
  pyProcess.stdin.on('error', (error) => console.error('Python stdin error:', error.message));
  pyProcess.stdin.write(inputData);
  pyProcess.stdin.end();

  // Decode as a stream so multi-byte characters split across chunks stay intact.
  pyProcess.stdout.setEncoding('utf8');
  pyProcess.stdout.on('data', (data) => {
    if (!finished) sendStream(event, turnId, data);
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
    finish(code ? `\n[Local synthesis exited with code ${code}.]\n` : null);
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

// --- DEEPSEEK CLOUD SYNTHESIZER ------------------------------------------
function buildSynthesisPrompt(responses) {
  return [
    'You are a multi-model synthesis engine. Merge the source responses below into one',
    'coherent answer. Preserve consensus, note meaningful disagreements, remove repetition,',
    'and do not invent facts that are absent from the sources.',
    '',
    ...responses.map((text, index) => `--- SOURCE ${index + 1} ---\n${text}`)
  ].join('\n');
}

async function runDeepSeekSynthesis(responses, event, turnId) {
  const validResponses = responses.filter(Boolean);
  if (validResponses.length === 0) {
    sendStream(event, turnId, '\n[No responses were collected. Cannot synthesize.]\n');
    sendComplete(event, turnId);
    return;
  }

  const apiKey = getKey('deepseek');
  if (!apiKey) {
    sendStream(event, turnId,
      '\n[DeepSeek API key is not configured. Click Settings or set DEEPSEEK_API_KEY.]\n');
    sendComplete(event, turnId);
    return;
  }

  sendStream(event, turnId, '\n[Cloud API synthesis via DeepSeek...]\n');

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
          { role: 'system', content: buildSynthesisPrompt(validResponses) },
          { role: 'user', content: 'Return the consolidated synthesis now.' }
        ],
        stream: true,
        temperature: 0.3
      }),
      // Covers the whole streamed body, not just the first byte.
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${detail.slice(0, 400) || response.statusText}`);
    }

    if (!response.body) {
      const data = await response.json();
      const text = extractModelText(data);
      if (!text) throw new Error('DeepSeek returned no text.');
      sendStream(event, turnId, text);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawContent = false;
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
    const message = describeFetchError(error, DEEPSEEK_TIMEOUT_MS);
    console.error('DeepSeek synthesis error:', message);
    sendStream(event, turnId, `\n[DeepSeek API error: ${message}]\n`);
  } finally {
    sendComplete(event, turnId);
  }
}

function runSynthesis(responses, event, engine, turnId) {
  const useCloud = String(engine || '').toLowerCase().includes('cloud');
  return useCloud
    ? runDeepSeekSynthesis(responses, event, turnId)
    : runSynthesizer(responses, event, turnId);
}

// Every adapter has the same shape: (config, prompt) -> { id, status, text, ms }.
// Adapters never touch IPC; the dispatcher owns that. New kinds are one entry
// here, not edits to the user-prompt handler.
const providerAdapters = {
  scrape: (config, promptText) => scrapers.scrape(config, promptText),
  api: (config, promptText) => runCustomModel(config, promptText)
};

function normalizeProviderResult(config, raw) {
  const result = raw && typeof raw === 'object'
    ? raw
    : { id: config.id, status: raw ? 'success' : 'error', text: typeof raw === 'string' ? raw : '', ms: 0 };

  const status = ['success', 'partial', 'error'].includes(result.status) ? result.status : 'error';
  let text = typeof result.text === 'string' ? result.text : '';

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
    ms: Number(result.ms) || 0
  };
}

// Dispatcher: call the adapter, normalize what it returns, then emit IPC. Success
// text goes to the model's own card; non-success results also reach the hybrid log.
async function runProvider(config, promptText, event, turnId) {
  const adapter = providerAdapters[config.kind] || providerAdapters.scrape;
  let result;

  try {
    result = normalizeProviderResult(config, await adapter(config, promptText));
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
    sendStream(event, turnId, `\n[${config.name}: ${result.text}]\n`);
  }

  return result;
}

app.whenReady().then(() => {
  createWindow();

  // 1. Handle Chat Prompts
  // payload: { turnId, promptText, activeModels, engine }.
  // Configs, and any API keys, are resolved in main from the registry.
  ipcMain.on('user-prompt', async (event, payload = {}) => {
    const { turnId, promptText = '', activeModels = [], engine = 'Local GPU' } = payload || {};

    // Without an id the renderer cannot route the replies, so refuse rather
    // than fall back to "the last turn".
    if (!turnId) {
      console.warn('Ignoring a prompt without a turnId.');
      return;
    }

    if (!Array.isArray(activeModels) || activeModels.length === 0) {
      sendStream(event, turnId, '\n[Please select at least one model.]\n');
      sendComplete(event, turnId);
      return;
    }

    const byId = new Map(loadProviders().map(provider => [provider.id, provider]));

    // Set UI to loading
    activeModels.forEach(id => {
      event.reply('reply-received', { turnId, model: id, text: 'Scraping...', status: 'loading', ms: 0 });
    });

    // Each id is dispatched through the registry: scrape -> Playwright, api -> fetch.
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
        return () => runProvider(config, promptText, event, turnId);
      })
      .filter(Boolean);

    // Run max 3 at a time
    const results = await runConcurrent(tasks, 3);

    // Synthesis gets usable answer text. Empty partials (reply never appeared)
    // and errors stay out.
    const textResponses = results
      .filter(r => r.status === 'fulfilled' && r.value && r.value.text && r.value.status !== 'error')
      .map(r => r.value.text);

    // A connection error thrown by the local engine must surface as a modal,
    // not as a silently stalled turn.
    try {
      runSynthesis(textResponses, event, engine, turnId);
    } catch (error) {
      console.error('Synthesis failed:', error.message);
      sendStream(event, turnId, `\n[Synthesis failed: ${error.message}]\n`);
      sendEngineError(event, turnId, error.message);
      sendComplete(event, turnId);
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

  // 4. Export the current turn as Markdown. The renderer sends the already
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
          viewport: { width: 1024, height: 768 }
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

// Stop any synthesis still running so no Python process outlives the app.
app.on('before-quit', () => {
  for (const child of activeChildren) child.kill();
  activeChildren.clear();
});