# LLM Explorer — follow-up handoff (2026-11-02)

**Goal:** the planned web version (static, bring-your-own API key) that could later serve small businesses.
**Desktop app:** C:\llm-explorer (Electron, vanilla HTML/JS). The web version does not use the local LLM.

## Cloudflare fit (Workers Free unless noted)
- **Hosting:** Workers static assets, free, at `explorer.zurichlocker.com` once the domain exists (workers.dev until then).
- **Known issue fix:** custom keys sit in page state or plain text when saved. For bring-your-own keys, keep them in the user's browser only, either session-only or encrypted with Web Crypto behind a passphrase, and never send them to your server.
- **Free demo provider:** Workers AI (10,000 neurons/day free) lets visitors try the merge flow with no key at all.
- **If you ever host keys:** store them as Worker secrets (or Secrets Store, which is in beta) behind one proxy Worker. Add Turnstile to that endpoint, plus a daily cap. AI Gateway (caching, logs, rate limits) is Conditional; check its plan terms at that point.
- **Shared keys across projects:** one Secrets Store entry for the Perplexity and DeepSeek keys could serve the cruise site, Beer League and Explorer.

## Related: local LLM (C:\Templar Archives\Cybernetics Core\llm)
Workers AI can act as a cloud fallback when the 16 GB laptop is short on memory. A loaded model leaves only ~0.5–1.4 GB free.

## Open questions
- [ ] Is the desktop app approved yet? That gates the web version.
- [ ] Charging later means accounts and billing. That's outside Workers Free; plan it only if there is demand.
