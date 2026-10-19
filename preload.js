const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendPrompt: (text, activeModels, engine, customModels) =>
    ipcRenderer.send('user-prompt', text, activeModels, engine, customModels),
  startLoginMode: () => ipcRenderer.send('login-mode'),
  getDeepSeekKeyStatus: () => ipcRenderer.invoke('settings:deepseek-status'),
  setDeepSeekKey: (key) => ipcRenderer.invoke('settings:set-deepseek-key', key),
  onReplyReceived: (callback) => ipcRenderer.on('reply-received', (event, data) => callback(data)),
  onHybridStream: (callback) => ipcRenderer.on('hybrid-stream', (event, chunk) => callback(chunk)),
  onHybridComplete: (callback) => ipcRenderer.on('hybrid-complete', () => callback()) 
});