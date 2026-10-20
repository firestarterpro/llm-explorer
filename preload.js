const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Chat prompts carry the renderer's turnId plus provider ids; main resolves
  // configs and keys and echoes the turnId back on every reply message.
  sendPrompt: (payload) => ipcRenderer.send('user-prompt', payload),
  // ids = the currently enabled website providers; main opens one headed
  // persistent context per id and waits for the user to close it.
  startLoginMode: (ids) => ipcRenderer.send('login-mode', ids),

  // Whether the Local GPU engine exists on this machine. The renderer hides
  // the Local option when it does not.
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),

  // Provider registry
  getProviders: () => ipcRenderer.invoke('providers:list'),
  // Read-only installable presets from templates.json.
  getTemplates: () => ipcRenderer.invoke('templates:list'),
  addProvider: (cfg) => ipcRenderer.invoke('providers:add', cfg),
  editProvider: (id, cfg) => ipcRenderer.invoke('providers:edit', id, cfg),
  removeProvider: (id) => ipcRenderer.invoke('providers:remove', id),

  // Encrypted key store (write-only for the renderer)
  setKey: (ref, key) => ipcRenderer.invoke('keys:set', ref, key),
  hasKey: (ref) => ipcRenderer.invoke('keys:has', ref),

  // Legacy DeepSeek aliases, now backed by the generic key store.
  getDeepSeekKeyStatus: () => ipcRenderer.invoke('settings:deepseek-status'),
  setDeepSeekKey: (key) => ipcRenderer.invoke('settings:set-deepseek-key', key),

  // Save the current turn as Markdown via the main-process save dialog.
  exportConversation: (text) => ipcRenderer.invoke('export-conversation', text),

  // Non-secret app preferences (e.g. showBrowsers), whitelisted in main.
  getAppPrefs: () => ipcRenderer.invoke('prefs:get'),
  setAppPref: (name, value) => ipcRenderer.invoke('prefs:set', name, value),

  // Restart the app (Settings > Reset Onboarding).
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  onReplyReceived: (callback) => ipcRenderer.on('reply-received', (event, data) => callback(data)),
  onHybridStream: (callback) => ipcRenderer.on('hybrid-stream', (event, payload) => callback(payload)),
  // Status and provider-error lines, kept apart from the synthesized answer.
  onHybridLog: (callback) => ipcRenderer.on('hybrid-log', (event, payload) => callback(payload)),
  onHybridComplete: (callback) => ipcRenderer.on('hybrid-complete', (event, payload) => callback(payload)),
  onEngineError: (callback) => ipcRenderer.on('engine-error', (event, payload) => callback(payload))
});