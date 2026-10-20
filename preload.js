const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Chat prompts carry the renderer's turnId plus provider ids; main resolves
  // configs and keys and echoes the turnId back on every reply message.
  sendPrompt: (payload) => ipcRenderer.send('user-prompt', payload),
  startLoginMode: () => ipcRenderer.send('login-mode'),

  // Provider registry
  getProviders: () => ipcRenderer.invoke('providers:list'),
  addProvider: (cfg) => ipcRenderer.invoke('providers:add', cfg),
  removeProvider: (id) => ipcRenderer.invoke('providers:remove', id),

  // Encrypted key store (write-only for the renderer)
  setKey: (ref, key) => ipcRenderer.invoke('keys:set', ref, key),
  hasKey: (ref) => ipcRenderer.invoke('keys:has', ref),

  // Legacy DeepSeek aliases, now backed by the generic key store.
  getDeepSeekKeyStatus: () => ipcRenderer.invoke('settings:deepseek-status'),
  setDeepSeekKey: (key) => ipcRenderer.invoke('settings:set-deepseek-key', key),

  // Save the current turn as Markdown via the main-process save dialog.
  exportConversation: (text) => ipcRenderer.invoke('export-conversation', text),

  onReplyReceived: (callback) => ipcRenderer.on('reply-received', (event, data) => callback(data)),
  onHybridStream: (callback) => ipcRenderer.on('hybrid-stream', (event, payload) => callback(payload)),
  onHybridComplete: (callback) => ipcRenderer.on('hybrid-complete', (event, payload) => callback(payload)),
  onEngineError: (callback) => ipcRenderer.on('engine-error', (event, payload) => callback(payload))
});