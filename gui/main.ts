import { app, BrowserWindow } from 'electron';
import * as path from 'path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Axle GUI',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
