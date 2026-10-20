       ☀️
      /\      /\      /\
     /  \    /  \    /  \
    /    \  /    \  /    \
   /      \/      \/      \
  /                        \
 /__________________________\
# 🏔️ LLM Explorer 🏔️
🚀 A **local-first**, multi-LLM orchestration cockpit.
🕸️ Scrapes web AIs (ChatGPT, Claude, Gemini, etc.) using Playwright.
🧠 Synthesizes them locally via **OpenVINO** on your Intel Arc GPU.
🛡️ Bypasses API costs and keeps your data 100% private.
🌐 **[Try the Live Web Demo here!](https://firestarterpro.github.io/llm-explorer/)**
🐍 Built with Python, Node.js, Electron, & Playwright.
⚡ **Zero API tokens. Zero cloud limits. All local.**

## Requirements

- **Node.js 18+** and **Python** (for the local synthesizer).
- **Local synthesis requires Python installed at `C:\llm\ov_env`.** The packaged
  Windows build expects the interpreter at
  `C:\llm\ov_env\Scripts\python.exe` and the synthesis script at
  `C:\llm\src\synthesize.py`. Python is **not** bundled into the installer yet —
  packaging Python into a standalone `.exe` is planned for a later task.
- The first scrape launches a Chromium window managed by Playwright.
  `npm install` runs `npx playwright install chromium`, which downloads the
  browser into `%LOCALAPPDATA%\ms-playwright`.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the Electron app from source. |
| `npm run build:win` | Build the Windows NSIS installer into `dist\`. |

