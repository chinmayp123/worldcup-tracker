// preload — the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wc", {
  onUpdate: (cb) => ipcRenderer.on("update", (_e, data) => cb(data)),
  onConfig: (cb) => ipcRenderer.on("config", (_e, cfg) => cb(cfg)),
  setMatch: (query) => ipcRenderer.invoke("set-match", query),
  getParlays: () => ipcRenderer.invoke("get-parlays"),
  getRecord: () => ipcRenderer.invoke("get-record"),
  toggleExpand: () => ipcRenderer.invoke("toggle-expand"),
  togglePin: () => ipcRenderer.invoke("toggle-pin"),
  refresh: () => ipcRenderer.invoke("refresh"),
  hide: () => ipcRenderer.invoke("hide"),
  quit: () => ipcRenderer.invoke("quit"),
});
