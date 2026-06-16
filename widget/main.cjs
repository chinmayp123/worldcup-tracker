// Electron main process — a frameless, always-on-top desktop widget around the shared
// data/model layer in ../lib.mjs. Main fetches + computes (Node, no CORS issues) and pushes
// plain JSON to the renderer, which draws the compact/full UI.
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const STATE_FILE = path.join(app.getPath("userData"), "widget-state.json");
const DEFAULTS = { x: null, y: null, expanded: false, query: null, pinned: true, openAtLogin: true };
function loadState() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function saveState(patch) {
  state = { ...state, ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}
let state = loadState();

const COMPACT = { width: 290, height: 250 };
const EXPANDED = { width: 390, height: 640 };

let lib;       // lazily imported ESM module
let win;
let tray;
let timer;
let lastData = null;

async function loadLib() {
  // dynamic import of an absolute path needs a file:// URL on Windows
  lib = await import(pathToFileURL(path.join(__dirname, "..", "lib.mjs")).href);
}

function createWindow() {
  const size = state.expanded ? EXPANDED : COMPACT;
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: state.x ?? undefined,
    y: state.y ?? undefined,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: state.pinned,
    skipTaskbar: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.pinned) win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "index.html"));

  // persist position when the user drags it
  win.on("moved", () => {
    const [x, y] = win.getPosition();
    saveState({ x, y });
  });
  win.on("closed", () => { win = null; });

  // send the latest data once the page is ready
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("config", { expanded: state.expanded, pinned: state.pinned, query: state.query });
    if (lastData) win.webContents.send("update", lastData);
  });
}

async function poll() {
  clearTimeout(timer);
  let nextDelay = 30000;
  try {
    const data = await lib.getWidgetState(state.query);
    lastData = data;
    if (win && !win.isDestroyed()) win.webContents.send("update", data);
    if (data.match?.halftime) nextDelay = 120000;          // back off at the break
    else if (data.match?.state === "post" || !data.match) nextDelay = 60000;
  } catch (e) {
    if (win && !win.isDestroyed()) win.webContents.send("update", { error: String(e?.message || e), matches: [] });
  }
  timer = setTimeout(poll, nextDelay);
}

// register (or clear) the widget as a Windows login item. In dev this launches electron.exe
// with the app path; once packaged it points at the built exe automatically.
function applyOpenAtLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!state.openAtLogin,
      path: process.execPath,
      args: [path.resolve(__dirname, "main.cjs")],
    });
  } catch {}
}

function buildTray() {
  // a tiny generated icon so the widget has a tray presence (show/hide/quit)
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVQ4y2NgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFAwHAAAFRAABxV0p7QAAAABJRU5ErkJggg=="
  );
  tray = new Tray(img);
  tray.setToolTip("WorldCup widget");
  const menu = Menu.buildFromTemplate([
    { label: "Show / hide", click: () => { if (win?.isVisible()) win.hide(); else win?.show(); } },
    { label: "Refresh now", click: () => poll() },
    { type: "separator" },
    {
      label: "Start with Windows", type: "checkbox", checked: !!state.openAtLogin,
      click: (item) => { saveState({ openAtLogin: item.checked }); applyOpenAtLogin(); },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { if (win?.isVisible()) win.hide(); else win?.show(); });
}

app.whenReady().then(async () => {
  await loadLib();
  createWindow();
  buildTray();
  applyOpenAtLogin();
  poll();
});

app.on("window-all-closed", () => { /* keep running in tray */ });
app.on("activate", () => { if (!win) createWindow(); });

// --- IPC from the renderer ---
ipcMain.handle("set-match", (_e, query) => {
  saveState({ query: query || null });
  poll();
  return state.query;
});
ipcMain.handle("toggle-expand", () => {
  const expanded = !state.expanded;
  saveState({ expanded });
  const size = expanded ? EXPANDED : COMPACT;
  if (win) { win.setResizable(true); win.setSize(size.width, size.height, true); win.setResizable(false); }
  return expanded;
});
ipcMain.handle("toggle-pin", () => {
  const pinned = !state.pinned;
  saveState({ pinned });
  if (win) win.setAlwaysOnTop(pinned, "screen-saver");
  return pinned;
});
ipcMain.handle("refresh", () => poll());
ipcMain.handle("hide", () => win?.hide());
ipcMain.handle("quit", () => app.quit());
