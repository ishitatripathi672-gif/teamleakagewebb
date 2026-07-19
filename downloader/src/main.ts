import { app, BrowserWindow, globalShortcut } from "electron";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
const PORT = process.env.PORT || 4500;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.on("context-menu", (e) => {
    e.preventDefault();
  });

  mainWindow.webContents.on("devtools-opened", () => {
    console.log("DevTools opened! Closing window for security...");
    if (mainWindow) {
      mainWindow.close();
    }
    app.quit();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("browser-window-focus", () => {
  globalShortcut.registerAll(
    [
      "Control+Shift+I",
      "Control+Shift+J",
      "Control+Shift+C",
      "F12",
      "Command+Option+I",
      "Command+Option+J",
      "Command+Option+C",
    ],
    () => {
      console.log("DevTools shortcut blocked.");
    }
  );
});

app.on("browser-window-blur", () => {
  globalShortcut.unregisterAll();
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
