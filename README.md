       ☀️
      /\      /\      /\
     /  \    /  \    /  \
    /    \  /    \  /    \
   /      \/      \/      \
  /                        \
 /__________________________\
# 🏔️ LLM Explorer 🏔️
🚀 A multi-LLM orchestration cockpit for Windows: one prompt, many sources, one answer.
🔎 Finds fresh web sources with the **DeepSeek Search API**. No browser, no CAPTCHAs.
🕸️ Can also ask web AIs (Brave, Google AI, Gemini, ChatGPT, …) in hidden Playwright browsers.
🧠 Merges every answer into one hybrid response with **DeepSeek** (`deepseek-flash`).
🛃 Optional Fidelity Clause: a source scores each key point, and 🎯 shows the result.
🔐 API keys are encrypted by Windows and never reach the page.
🌐 **[Try the Live Web Demo here!](https://firestarterpro.github.io/llm-explorer/)**
⚡ Built with Node.js, Electron & Playwright.

## How it works

1. **Sources.** Your prompt goes to every source ticked in the left panel.
   - **DeepSeek Search** (on by default) calls `POST https://api.deepseek.com/v1/tools/search`
     with your question (up to 128 characters) and returns the top web results.
   - **Brave** (on by default) asks Brave's AI answer page in an off-screen browser.
   - Optional: Google AI Mode, Gemini, DeepSeek Chat, the templates under
     **➕ Add from Template** (ChatGPT, Claude, Perplexity, Grok, Meta AI, Copilot), or any
     OpenAI-compatible API (OpenAI, Groq, OpenRouter, a local Ollama server).
2. **Synthesis.** DeepSeek merges the usable answers into one plain-text response that names
   its sources and cites the URLs it relies on. Status lines and provider errors appear in a
   log under the answer, never inside it.
3. **Conversation.** Fork any prompt into branches (🌿), feed earlier turns back in with
   History Context, and export a turn as Markdown (📥).

Your prompts are sent to DeepSeek and to each website you enable.

## Requirements

- Windows 10 or 11 (x64).
- A **DeepSeek API key** from [platform.deepseek.com](https://platform.deepseek.com/). One key
  runs both Search and synthesis: Search is billed per request, synthesis per token.
- Nothing else for the installer: the Chromium build used for scraping ships inside it.
- To run from source: **Node.js 18+**. `npm install` downloads Playwright's Chromium into
  `pw-browsers\`.

## First run

1. Run `LLM Explorer Setup <version>.exe`. The installer is not code-signed yet, so Windows
   SmartScreen asks you to confirm: **More info → Run anyway**.
2. The setup wizard asks for your DeepSeek key. It is stored encrypted (Windows DPAPI via
   Electron `safeStorage`).
3. Send a prompt. Tick more sources in the left panel whenever you like.
4. If a site needs an account or shows a CAPTCHA, click **🔐 Login Mode**, sign in or solve it
   in the window that opens, then close the window. Each site's session is saved.

**⚙ Settings** has the DeepSeek key, **Show browsers during scraping (Debug)**,
**Reset Onboarding Wizard** and **Clear All Conversations**.

From source you can also set the key in the environment as `DEEPSEEK_API_KEY`.

## Optional: local GPU synthesis

The original OpenVINO synthesizer is still available, but it is no longer the default. When
`C:\llm\ov_env\Scripts\python.exe` and `C:\llm\src\synthesize.py` exist, a **⚡ Local GPU**
engine option appears next to Send. Otherwise it is hidden and DeepSeek is used.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the Electron app from source. |
| `npm run build:win` | Build the Windows NSIS installer into `dist\`. Installs Chromium into `pw-browsers\` first if it is missing. |
