const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('verse', { resize: (collapsed, settingsOpen) => ipcRenderer.send('resize-overlay', Boolean(collapsed), Boolean(settingsOpen)) });
