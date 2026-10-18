const { chromium } = require('playwright');
const path = require('path');

// Utility to generate unique user data dirs
const getDataDir = (name) => path.join(__dirname, `user_data_${name}`);

// A generic scraper factory to handle the repetitive Playwright logic
async function genericScrape(config, promptText, event) {
  let context;
  try {
    context = await chromium.launchPersistentContext(getDataDir(config.id), {
      headless: false, // Set to true once you verify they all work!
      viewport: { width: 1280, height: 800 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    console.log(`Navigating to ${config.name}...`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // Wait for React to hydrate

    // 1. Find the input box
    const input = page.locator(config.inputSelector).first();
    await input.waitFor({ timeout: 15000 });
    
    // 2. Type and Submit
    await input.fill(promptText);
    await page.waitForTimeout(500);
    
    if (config.submitAction === 'enter') {
      await page.keyboard.press('Enter');
    } else {
      await page.locator(config.submitButton).first().click();
    }

    console.log(`Waiting for ${config.name} response...`);
    
    // 3. Wait for generation to finish (Polling text length)
    let previousText = "";
    let stableCount = 0;
    let attempts = 0;

    while (stableCount < 3 && attempts < 30) {
      const currentText = await page.locator(config.responseSelector).last().innerText().catch(() => "");
      
      if (currentText === previousText && currentText.length > 10) {
        stableCount++;
      } else {
        stableCount = 0; 
        previousText = currentText;
      }
      await page.waitForTimeout(1000);
      attempts++;
    }

    if (!previousText || previousText.length < 5) {
      throw new Error("Timeout waiting for text generation.");
    }

    // Clean up Markdown code blocks if any
    previousText = previousText.replace(/^```[a-z]*\n/i, '').replace(/\n```$/i, '');

    event.reply('reply-received', { model: config.id, text: previousText, status: 'success' });
    return previousText;

  } catch (error) {
    console.error(`${config.name} error:`, error.message);
    event.reply('reply-received', { model: config.id, text: `Error: ${error.message}`, status: 'error' });
    return null;
  } finally {
    if (context) await context.close();
  }
}

// --- EXPORTED SCRAPERS ---
// Note: These selectors will likely need tweaking tomorrow as websites change daily.
const providers = {
  google: {
    id: 'google', name: 'Google AI', url: 'https://www.google.com/search?udm=50',
    inputSelector: 'textarea[aria-label="Search"]',
    submitAction: 'enter', responseSelector: 'div[role="main"]'
  },
  brave: {
    id: 'brave', name: 'Brave', url: 'https://search.brave.com/ask',
    inputSelector: 'textarea, input[type="text"]',
    submitAction: 'enter', responseSelector: 'pre, code, .markdown'
  },
  chatgpt: {
    id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com',
    inputSelector: '#prompt-textarea',
    submitAction: 'enter', responseSelector: '.markdown'
  },
  claude: {
    id: 'claude', name: 'Claude', url: 'https://claude.ai/new',
    inputSelector: 'div[contenteditable="true"]',
    submitAction: 'enter', responseSelector: '.font-claude-message'
  },
  gemini: {
    id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app',
    inputSelector: 'div.ql-editor, textarea',
    submitAction: 'enter', responseSelector: 'message-content, .model-response-text'
  },
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com',
    inputSelector: 'textarea',
    submitAction: 'enter', responseSelector: 'div.markdown'
  },
  grok: {
    id: 'grok', name: 'Grok', url: 'https://grok.com',
    inputSelector: 'textarea',
    submitAction: 'enter', responseSelector: '.message-bubble'
  },
  meta: {
    id: 'meta', name: 'Meta AI', url: 'https://www.meta.ai',
    inputSelector: 'textarea',
    submitAction: 'enter', responseSelector: 'div[role="article"]'
  },
  copilot: {
    id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com',
    inputSelector: 'textarea#userInput, textarea',
    submitAction: 'enter', responseSelector: 'div[data-content="ai-message"]'
  },
  perplexity: {
    id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai',
    inputSelector: 'textarea',
    submitAction: 'enter', responseSelector: '.prose'
  }
};

module.exports = {
  scrape: (id, prompt, event) => genericScrape(providers[id], prompt, event),
  providers
};