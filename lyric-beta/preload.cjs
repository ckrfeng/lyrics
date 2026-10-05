const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, listener) => {
  const handler = (_event, data) => listener(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
// No tokens, arbitrary channels, filesystem paths, or URL-opening API cross this bridge.
contextBridge.exposeInMainWorld('verse', {
  init: () => ipcRenderer.invoke('verse:init'),
  resize: (height, collapsed) => ipcRenderer.send('verse:resize', { height, collapsed }),
  preferences: patch => ipcRenderer.invoke('verse:preferences', patch),
  control: command => ipcRenderer.invoke('verse:control', command),
  openTrack: () => ipcRenderer.invoke('verse:open-track'),
  onState: listener => subscribe('verse:state', listener),
  onVisibility: listener => subscribe('verse:visibility', listener)
});
contextBridge.exposeInMainWorld('verseSetup', {
  init: () => ipcRenderer.invoke('setup:init'),
  connect: clientId => ipcRenderer.invoke('setup:connect', clientId),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  demo: () => ipcRenderer.invoke('setup:demo'),
  openHelp: kind => ipcRenderer.invoke('setup:help', kind)
});
