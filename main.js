const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { chromium } = require('playwright');
const { spawn } = require('child_process');

// Independent profile folders to prevent Playwright lock conflicts
const GOOGLE_USER_DATA = path.join(__dirname, 'user_data_google');
const BRAVE_USER_DATA = path.join(__dirname, 'user_data_brave');

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

// --- GOOGLE AI MODE SCRAPER ---
async function scrapeGoogle(promptText, event) {
  let context;
  try {
    context = await chromium.launchPersistentContext(GOOGLE_USER_DATA, {
      headless: false, 
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
  
    console.log("Navigating to Google AI Mode...");
    const encodedPrompt = encodeURIComponent(promptText);
    await page.goto(`https://www.google.com/search?udm=50&q=${encodedPrompt}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Check for CAPTCHA
    const isCaptcha = await page.locator('text="unusual traffic"').count() > 0 || await page.locator('iframe[src*="recaptcha"]').count() > 0;
    if (isCaptcha) {
      console.log("CAPTCHA detected. Waiting 30 seconds...");
      event.reply('reply-received', { model: 'google', text: 'Waiting for CAPTCHA solve...', status: 'loading' });
      await page.waitForTimeout(30000); 
    }

    let previousText = "";
    let stableCount = 0;
    let attempts = 0;

    // Resilient polling for text stability
    while (stableCount < 3 && attempts < 15) {
      const currentText = await page.evaluate(() => {
        // Try the main content area, then the search results, then the whole body
        const main = document.querySelector('div[role="main"]') || document.querySelector('#search') || document.body;
        return main ? main.innerText : "";
      }).catch(() => "");

      if (currentText === previousText && currentText.length > 50) {
        stableCount++;
      } else {
        stableCount = 0; 
        previousText = currentText;
      }
      await page.waitForTimeout(1000);
      attempts++;
    }

    // Clean up known Google UI junk
    if (previousText) {
        previousText = previousText
            .replace("Skip to main content", "")
            .replace("Accessibility help", "")
            .replace("AI Mode response is ready", "")
            .replace("Skip to previous prompt", "")
            .trim();
    }

    if (!previousText || previousText.length < 50) throw new Error("Failed to scrape meaningful text.");

    console.log("Google scrape successful!");
    event.reply('reply-received', { model: 'google', text: previousText, status: 'success' });
    return previousText;
  } catch (error) {
    console.error("Google error:", error);
    event.reply('reply-received', { model: 'google', text: `Error: ${error.message}`, status: 'error' });
    return null;
  } finally {
    if (context) await context.close();
  }
}

// --- BRAVE SEARCH SCRAPER ---
async function scrapeBrave(promptText, event) {
  let context;
  try {
    context = await chromium.launchPersistentContext(BRAVE_USER_DATA, {
      headless: false, 
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
  
    console.log("Navigating to Brave Search...");
    await page.goto('https://search.brave.com/ask', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    const inputSelector = 'textarea, input[type="text"], input[type="search"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    
    const formattingSuffix = "\n\nCRITICAL INSTRUCTION: Wrap your entire response inside a markdown code block (```text ... ```). Do not write anything outside of the code block.";
    const finalPrompt = promptText + formattingSuffix;

    await page.fill(inputSelector, finalPrompt);
    await page.keyboard.press('Enter');
    
    console.log("Waiting for Brave code block...");
    await page.waitForSelector('pre, code', { timeout: 45000 });
    await page.waitForTimeout(2000);

    let replyText = await page.locator('pre, code').last().innerText().catch(() => "");
    if (!replyText || replyText.length < 10) {
      replyText = await page.locator('.markdown, .prose').last().innerText().catch(() => "Failed to scrape.");
    }

    // Clean up markdown ticks
    replyText = replyText.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '');
    
    console.log("Brave scrape successful!");
    event.reply('reply-received', { model: 'brave', text: replyText, status: 'success' });
    return replyText;
  } catch (error) {
    console.error("Brave error:", error);
    event.reply('reply-received', { model: 'brave', text: `Error: ${error.message}`, status: 'error' });
    return null;
  } finally {
    if (context) await context.close();
  }
}

// --- RUN THE PYTHON SYNTHESIZER ---
function runSynthesizer(responses, event) {
  const validResponses = responses.filter(Boolean);
  if (validResponses.length === 0) {
    event.reply('hybrid-stream', '\n[No responses were scraped successfully. Cannot synthesize.]\n');
    return;
  }

  console.log(`Passing ${validResponses.length} responses to OpenVINO...`);
  event.reply('hybrid-stream', '\n[Running local OpenVINO synthesis...]\n');

  const inputData = validResponses.join('\n---END---\n');
  const pyProcess = spawn(PYTHON_EXE, [PYTHON_SCRIPT_PATH]);

  pyProcess.stdin.write(inputData);
  pyProcess.stdin.end();

  pyProcess.stdout.on('data', (data) => {
    event.reply('hybrid-stream', data.toString());
  });

  pyProcess.stderr.on('data', (data) => {
    console.error(`Python Error: ${data}`);
  });

  pyProcess.on('close', (code) => {
    console.log(`Python process exited with code ${code}`);
    // NEW: Tell the UI we are completely done
    event.reply('hybrid-complete'); 
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.on('user-prompt', async (event, promptText) => {
    // Set both to loading in the UI
    event.reply('reply-received', { model: 'google', text: 'Scraping...', status: 'loading' });
    event.reply('reply-received', { model: 'brave', text: 'Scraping...', status: 'loading' });
    
    // Run BOTH scrapers in parallel
    const [googleReply, braveReply] = await Promise.all([
      scrapeGoogle(promptText, event),
      scrapeBrave(promptText, event)
    ]);
    
    // Pass BOTH to the local synthesizer
    runSynthesizer([googleReply, braveReply], event);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});