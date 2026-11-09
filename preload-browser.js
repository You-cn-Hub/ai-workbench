const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("br", {
  go: (url) => ipcRenderer.invoke("browser:go", url),
  back: () => ipcRenderer.invoke("browser:back"),
  forward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  home: () => ipcRenderer.invoke("browser:home"),
  external: () => ipcRenderer.invoke("browser:external"),
  hide: () => ipcRenderer.invoke("panel:hide"),
  onState: (cb) => ipcRenderer.on("browser:state", (_e, d) => cb(d)),
});
