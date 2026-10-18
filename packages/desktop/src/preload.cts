// Sandboxed preloads must be CommonJS. The first-run page's only two actions.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("homeostat", {
  choose: () => ipcRenderer.invoke("kb:choose"),
  clone: (url: string) => ipcRenderer.invoke("kb:clone", String(url)),
});
