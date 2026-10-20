const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Playwright resolves its browser folder once, when it is first required, so
// this has to run before the require below. A packaged build ships Chromium as
// resources/ms-playwright (see package.json "extraResources"); in development
// we prefer the locally installed pw-browsers folder over the machine cache, so
// a clean checkout behaves like the installer.
if (app && app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'ms-playwright');
} else if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(path.join(__dirname, 'pw-browsers'))) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'pw-browsers');
}

const { chromium } = require('playwright');

// Profile directories must be writable at runtime. In a packaged app __dirname
// points into app.asar, which is read-only, so keep sessions under userData.
// Login Mode and scraping both reach this through launchContext(), so they share
// one persistent session per provider.
function getProfileDir(name) {
  const root = app && app.isPackaged
    ? path.join(app.getPath('userData'), 'browser_profiles')
    : __dirname;
  return path.join(root, `user_data_${name}`);
}

// Every persistent context launched here is tracked so quit can close them
// deterministically. Playwright only cleans up after a normal process exit; if
// the app is force-closed, chrome.exe would otherwise keep running.
const openContexts = new Set();

function trackContext(context) {
  openContexts.add(context);
  context.once('close', () => openContexts.delete(context));
  return context;
}

// Called from main.js on before-quit. Closing twice is harmless: Playwright
// makes close() idempotent, and a context that already closed is gone from the
// set.
async function closeAll() {
  const contexts = [...openContexts];
  openContexts.clear();
  await Promise.all(contexts.map(context => context.close().catch(error => {
    console.warn('Could not close a Playwright context:', error.message);
  })));
}

// The single Playwright entry point for the app. Scraping and Login Mode must
// launch with identical options, otherwise the same profile is opened by two
// different browser configurations and the saved session stops matching.
// opts: { headless?, viewport? }.
async function launchContext(id, opts = {}) {
  const userDataDir = getProfileDir(id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: opts.headless === true,
    // scripts/install-browsers.js installs with --no-shell, so only the full
    // Chromium build ships. Playwright would otherwise look for the separate
    // chrome-headless-shell binary when headless is requested.
    ...(opts.headless === true ? { channel: 'chromium' } : {}),
    viewport: opts.viewport || { width: 1280, height: 800 },
    // --no-sandbox and a hard-coded Chrome/120 user agent were both removed:
    // they weakened the browser sandbox and made the browser fingerprint
    // inconsistent between Login Mode and scraping.
    args: ['--disable-blink-features=AutomationControlled']
  });
  return trackContext(context);
}

// Response completion tuning. A provider can override timeoutMs and may supply
// a doneSelector that is visible while a reply is generating.
const DEFAULT_RESPONSE_TIMEOUT_MS = 180000;
const NEW_RESPONSE_POLL_MS = 500;
const STABLE_POLL_MS = 1000;
const STABLE_SECONDS = 3;

function cleanResponseText(text) {
  return String(text || '')
    .replace(/^```[a-z]*\n/i, '')
    .replace(/\n```$/i, '');
}

// A generic scraper factory to handle the repetitive Playwright logic.
// It returns { id, status, text, ms } and never touches IPC; main.js owns the
// dispatcher and turns this result into reply-received / hybrid-stream events.
async function genericScrape(config, promptText) {
  const startedAt = Date.now();
  let context;
  try {
    context = await launchContext(config.id);
    const page = context.pages()[0] || await context.newPage();
    console.log(`Navigating to ${config.name}...`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // Wait for React to hydrate

    // 1. Find the input box
    const input = page.locator(config.inputSelector).first();
    await input.waitFor({ timeout: 15000 });

    // 2. Snapshot the response list before submitting, so an old reply can
    // never be mistaken for the new one.
    const responseLocator = page.locator(config.responseSelector);
    const responseCountBefore = await responseLocator.count();
    const configuredTimeout = Number(config.timeoutMs);
    const responseTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_RESPONSE_TIMEOUT_MS;

    // 3. Type and Submit
    await input.fill(promptText);
    await page.waitForTimeout(500);

    if (config.submitAction === 'enter') {
      await page.keyboard.press('Enter');
    } else {
      await page.locator(config.submitButton).first().click();
    }

    console.log(`Waiting for ${config.name} response...`);
    const deadline = Date.now() + responseTimeoutMs;

    // 4. Wait for a new response element. Polling avoids a long Playwright
    // timeout throwing before we can report a partial result.
    let newResponseAppeared = false;
    while (Date.now() < deadline) {
      const currentCount = await responseLocator.count().catch(() => 0);
      if (currentCount > responseCountBefore) {
        newResponseAppeared = true;
        break;
      }
      await page.waitForTimeout(NEW_RESPONSE_POLL_MS);
    }

    if (!newResponseAppeared) {
      const seconds = Math.round(responseTimeoutMs / 1000);
      console.warn(`${config.name}: timed out after ${seconds}s waiting for a new response element.`);
      // Empty text means no usable reply was scraped. main.js turns this into
      // the user-facing timeout message and keeps it out of synthesis.
      return { id: config.id, status: 'partial', text: '', ms: Date.now() - startedAt };
    }

    // 5. A reply is complete when its text is unchanged for three consecutive
    // seconds, or when the provider's stop/done control has disappeared.
    let previousText = '';
    let stableCount = 0;
    let doneHidden = false;

    while (Date.now() < deadline) {
      let done = false;
      if (config.doneSelector) {
        const doneControl = page.locator(config.doneSelector).first();
        const doneCount = await doneControl.count().catch(() => 0);
        done = doneCount === 0 || !(await doneControl.isVisible().catch(() => false));
      }

      const currentText = await responseLocator.last().innerText().catch(() => '');
      if (currentText.length > 0 && currentText === previousText) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      previousText = currentText;

      if (done && currentText.trim()) {
        doneHidden = true;
        break;
      }
      if (stableCount >= STABLE_SECONDS) break;

      await page.waitForTimeout(STABLE_POLL_MS);
    }

    const completed = doneHidden || stableCount >= STABLE_SECONDS;
    const cleanText = cleanResponseText(previousText);
    const status = completed ? 'success' : 'partial';

    if (status === 'partial') {
      const seconds = Math.round(responseTimeoutMs / 1000);
      console.warn(`${config.name}: timed out after ${seconds}s; returning partial text.`);
    }

    return {
      id: config.id,
      status,
      text: cleanText,
      ms: Date.now() - startedAt
    };

  } catch (error) {
    console.error(`${config.name} error:`, error.message);
    return {
      id: config.id,
      status: 'error',
      text: `Error: ${error.message}`,
      ms: Date.now() - startedAt
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// --- EXPORTED SCRAPERS ---
// Provider configs live in providers.json (built-ins) and userData/providers.json
// (user-added), loaded by main.js. This module only knows how to run a config.
module.exports = {
  scrape: (config, prompt) => genericScrape(config, prompt),
  launchContext,
  getProfileDir,
  closeAll
};