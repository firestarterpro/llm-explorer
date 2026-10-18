const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const scrapers = require('./scrapers');

const PYTHON_SCRIPT_PATH = 'C:\\llm\\src\\synthesize.py';
const PYTHON_EXE = 'C:\\llm\\ov_env\\Scripts\\python.exe';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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

  console.log(`Passing ${validResponses.length} responses to OpenVINO...`);
  event.reply('hybrid-stream', '\n[Running local OpenVINO synthesis...]\n');

  const inputData = validResponses.join('\n---END---\n');
  const pyProcess = spawn(PYTHON_EXE, [PYTHON_SCRIPT_PATH]);

  pyProcess.stdin.write(inputData);
  pyProcess.stdin.end();

  pyProcess.stdout.on('data', (data) => event.reply('hybrid-stream', data.toString()));
  pyProcess.stderr.on('data', (data) => console.error(`Python Error: ${data}`));

  pyProcess.on('close', (code) => {
    event.reply('hybrid-complete');
  });
}

app.whenReady().then(() => {
  createWindow();

  // 1. Handle Chat Prompts
  ipcMain.on('user-prompt', async (event, promptText, activeModels) => {
    if (activeModels.length === 0) {
      event.reply('hybrid-stream', '\n[Please select at least one model.]\n');
      event.reply('hybrid-complete');
      return;
    }

    // Set UI to loading
    activeModels.forEach(id => {
      event.reply('reply-received', { model: id, text: 'Scraping...', status: 'loading' });
    });

    // Create tasks for the queue
    const tasks = activeModels.map(id => () => scrapers.scrape(id, promptText, event));

    // Run max 3 at a time
    const results = await runConcurrent(tasks, 3);
    
    // Extract successful text responses
    const textResponses = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    runSynthesizer(textResponses, event);
  });

  // 2. Handle Login Mode
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