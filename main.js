const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
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

// --- SECURE LOCAL SETTINGS ------------------------------------------------
// DeepSeek keys are encrypted with Electron safeStorage (DPAPI on Windows)
// and stored in Electron's per-user data directory, never in the repo.
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

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const settings = loadSettings();
  if (!settings.deepseekApiKeyEnc || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(settings.deepseekApiKeyEnc, 'base64')).trim();
  } catch (error) {
    console.error('Could not decrypt the stored DeepSeek API key:', error.message);
    return '';
  }
}

function setDeepSeekApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: 'OS encryption is unavailable. Set DEEPSEEK_API_KEY in the environment instead.'
    };
  }
  const settings = loadSettings();
  settings.deepseekApiKeyEnc = safeStorage.encryptString(key).toString('base64');
  saveSettings(settings);
  return { ok: true };
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
  win.loadFile('index.html');
}

// --- QUEUE SYSTEM (Max 3 concurrent browsers to prevent RAM crash) ---
async function runConcurrent(tasks, limit = 3) {
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(executing);
}

// --- PYTHON SYNTHESIZER ---
function runSynthesizer(responses, event) {
  const validResponses = responses.filter(Boolean);
  if (validResponses.length === 0) {
    event.reply('hybrid-stream', '\n[No responses were scraped successfully. Cannot synthesize.]\n');
    event.reply('hybrid-complete');
    return;
  }

  if (!fs.existsSync(PYTHON_EXE) || !fs.existsSync(PYTHON_SCRIPT_PATH)) {
    event.reply('hybrid-stream',
      '\n[Local GPU synthesis is unavailable: Python or synthesize.py was not found. Switch the engine to Cloud API.]\n');
    event.reply('hybrid-complete');
    return;
  }

  console.log(`Passing ${validResponses.length} responses to OpenVINO...`);
  event.reply('hybrid-stream', '\n[Running local OpenVINO synthesis...]\n');

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
    if (message) event.reply('hybrid-stream', message);
    event.reply('hybrid-complete');
  };

  killTimer = setTimeout(() => {
    pyProcess.kill();
    finish(`\n[Local synthesis timed out after ${PYTHON_TIMEOUT_MS / 1000}s and was stopped.]\n`);
  }, PYTHON_TIMEOUT_MS);

  pyProcess.on('error', (error) => {
    console.error('Python failed to start:', error.message);
    finish(`\n[Local synthesis failed to start: ${error.message}]\n`);
  });

  // Python exiting early would otherwise raise an unhandled EPIPE here.
  pyProcess.stdin.on('error', (error) => console.error('Python stdin error:', error.message));
  pyProcess.stdin.write(inputData);
  pyProcess.stdin.end();

  // Decode as a stream so multi-byte characters split across chunks stay intact.
  pyProcess.stdout.setEncoding('utf8');
  pyProcess.stdout.on('data', (data) => {
    if (!finished) event.reply('hybrid-stream', data);
  });
  pyProcess.stderr.on('data', (data) => console.error(`Python Error: ${data}`));

  pyProcess.on('close', (code) => {
    finish(code ? `\n[Local synthesis exited with code ${code}.]\n` : null);
  });
}

// --- CUSTOM API MODELS ----------------------------------------------------
// Custom models bypass Playwright and call their configured endpoint directly.
async function runCustomModel(model, promptText, event) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;

    const response = await fetch(model.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.name,
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

    event.reply('reply-received', { model: model.id, text, status: 'success' });
    return text;
  } catch (error) {
    const message = describeFetchError(error, CUSTOM_MODEL_TIMEOUT_MS);
    console.error(`Custom model "${model.name}" error:`, message);
    event.reply('reply-received', {
      model: model.id,
      text: `Error: ${message}`,
      status: 'error'
    });
    return null;
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

async function runDeepSeekSynthesis(responses, event) {
  const validResponses = responses.filter(Boolean);
  if (validResponses.length === 0) {
    event.reply('hybrid-stream', '\n[No responses were collected. Cannot synthesize.]\n');
    event.reply('hybrid-complete');
    return;
  }

  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    event.reply('hybrid-stream',
      '\n[DeepSeek API key is not configured. Click Settings or set DEEPSEEK_API_KEY.]\n');
    event.reply('hybrid-complete');
    return;
  }

  event.reply('hybrid-stream', '\n[Cloud API synthesis via DeepSeek...]\n');

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
      event.reply('hybrid-stream', text);
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
          event.reply('hybrid-stream', delta);
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
    event.reply('hybrid-stream', `\n[DeepSeek API error: ${message}]\n`);
  } finally {
    event.reply('hybrid-complete');
  }
}

function runSynthesis(responses, event, engine) {
  const useCloud = String(engine || '').toLowerCase().includes('cloud');
  return useCloud
    ? runDeepSeekSynthesis(responses, event)
    : runSynthesizer(responses, event);
}

app.whenReady().then(() => {
  createWindow();

  // 1. Handle Chat Prompts
  // activeModels: IDs selected in the left panel.
  // engine: value from #engineToggle ('Local GPU' or 'Cloud').
  // customModels: full configs for type:'custom' entries, which skip Playwright.
  ipcMain.on('user-prompt', async (event, promptText, activeModels = [], engine = 'Local GPU', customModels = []) => {
    if (!Array.isArray(activeModels) || activeModels.length === 0) {
      event.reply('hybrid-stream', '\n[Please select at least one model.]\n');
      event.reply('hybrid-complete');
      return;
    }

    const customById = new Map(
      (Array.isArray(customModels) ? customModels : [])
        .filter(model => model && model.id && model.endpoint)
        .map(model => [String(model.id), model])
    );

    // Set UI to loading
    activeModels.forEach(id => {
      event.reply('reply-received', { model: id, text: 'Scraping...', status: 'loading' });
    });

    // Built-in models use Playwright; custom models use their API endpoint.
    const tasks = activeModels
      .map(id => {
        const custom = customById.get(String(id));
        if (custom) return () => runCustomModel(custom, promptText, event);
        if (scrapers.providers[id]) return () => scrapers.scrape(id, promptText, event);
        event.reply('reply-received', {
          model: id,
          text: `Error: unknown model "${id}"`,
          status: 'error'
        });
        return null;
      })
      .filter(Boolean);

    // Run max 3 at a time
    const results = await runConcurrent(tasks, 3);

    // Extract successful text responses
    const textResponses = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    runSynthesis(textResponses, event, engine);
  });

  // 2. Secure DeepSeek settings (the key itself never returns to the renderer)
  ipcMain.handle('settings:deepseek-status', () => ({
    configured: !!getDeepSeekApiKey(),
    source: process.env.DEEPSEEK_API_KEY ? 'environment' : 'settings'
  }));

  ipcMain.handle('settings:set-deepseek-key', (event, key) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) return { ok: false, error: 'API key cannot be empty.' };
    try {
      return setDeepSeekApiKey(trimmed);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 3. Handle Login Mode
  ipcMain.on('login-mode', async (event) => {
    console.log("Starting Login Mode. Please log into the windows that open.");
    
    // Sequentially open each provider so RAM doesn't blow up
    for (const [id, config] of Object.entries(scrapers.providers)) {
      try {
        const context = await chromium.launchPersistentContext(path.join(__dirname, `user_data_${id}`), {
          headless: false,
          viewport: { width: 1024, height: 768 },
          args: ['--disable-blink-features=AutomationControlled']
        });
        const page = await context.newPage();
        await page.goto(config.url, { timeout: 60000 }).catch(() => {});
        
        // Wait for user to manually close the window
        await new Promise(resolve => {
          context.on('close', resolve);
        });
      } catch (e) {
        console.error(`Login failed for ${id}:`, e);
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