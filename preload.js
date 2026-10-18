const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendPrompt: (text, activeModels) => ipcRenderer.send('user-prompt', text, activeModels),
  startLoginMode: () => ipcRenderer.send('login-mode'),
  onReplyReceived: (callback) => ipcRenderer.on('reply-received', (event, data) => callback(data)),
  onHybridStream: (callback) => ipcRenderer.on('hybrid-stream', (event, chunk) => callback(chunk)),
  onHybridComplete: (callback) => ipcRenderer.on('hybrid-complete', () => callback()) 
});