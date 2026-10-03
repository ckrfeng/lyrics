const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('node:path');
let win;
app.whenReady().then(() => {
  const { x, y } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({ width: 280, height: 190, x: x + 20, y: y + 20, frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');
  ipcMain.on('resize-overlay', (event, collapsed, settingsOpen) => {
    if (event.sender !== win.webContents) return;
    win.setSize(collapsed ? 190 : 280, collapsed ? 48 : settingsOpen ? 265 : 190);
  });
  globalShortcut.register('CommandOrControl+Shift+L', () => win.isVisible() ? win.hide() : win.show());
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
