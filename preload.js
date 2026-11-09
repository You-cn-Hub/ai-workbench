const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wb", {
  list: () => ipcRenderer.invoke("plugins:list"),
  activate: (id) => ipcRenderer.invoke("plugin:activate", id),
  launch: (id) => ipcRenderer.invoke("plugin:launch", id),
  quit: (id) => ipcRenderer.invoke("plugin:quit", id),
  scanPrograms: () => ipcRenderer.invoke("app:scanPrograms"),
  addProgramPath: (p) => ipcRenderer.invoke("app:addProgramPath", p),
  addFile: (p) => ipcRenderer.invoke("app:addFile", p),
  pickFile: () => ipcRenderer.invoke("app:pickFile"),
  openFile: (id, f) => ipcRenderer.invoke("app:openFile", id, f),
  openFileWith: (exe, f) => ipcRenderer.invoke("app:openFileWith", exe, f),
  detachFile: (id, f) => ipcRenderer.invoke("app:detachFile", id, f),
  rebuildIcon: (id) => ipcRenderer.invoke("app:rebuildIcon", id),
  openWith: (f) => ipcRenderer.invoke("app:openWith", f),
  getPathForFile: (f) => {
    try {
      return require("electron").webUtils.getPathForFile(f);
    } catch {
      return "";
    }
  },
  removeProgram: (id) => ipcRenderer.invoke("app:removeProgram", id),
  touch: () => ipcRenderer.invoke("win:touch"),
  getPos: () => ipcRenderer.invoke("win:getPos"),
  pin: (on) => ipcRenderer.invoke("win:pin", on),
  isPinned: () => ipcRenderer.invoke("win:isPinned"),
  setPos: (x, y) => ipcRenderer.invoke("win:setPos", x, y),
  hidePanel: () => ipcRenderer.invoke("panel:hide"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setHotkey: (acc) => ipcRenderer.invoke("settings:setHotkey", acc),
  beginCapture: () => ipcRenderer.invoke("settings:beginCapture"),
  endCapture: () => ipcRenderer.invoke("settings:endCapture"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  toTray: () => ipcRenderer.invoke("win:toTray"),
  reorder: (ids) => ipcRenderer.invoke("plugins:reorder", ids),
  reload: () => ipcRenderer.invoke("plugins:reload"),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  onHotkey: (cb) => ipcRenderer.on("hotkey:trigger", (_e, id) => cb(id)),
  onState: (cb) => ipcRenderer.on("state:changed", (_e, d) => cb(d)),
  onIconsHealed: (cb) => ipcRenderer.on("icons:healed", (_e, n) => cb(n)),
});
