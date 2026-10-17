// Мост между страницей и приложением: узкий набор функций, без доступа к Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibeNative', {
  info: () => ipcRenderer.invoke('info'),
  saveProjectDialog: (suggestedName) => ipcRenderer.invoke('project:save-dialog', suggestedName),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  readProject: (path) => ipcRenderer.invoke('project:read', path),
  writeProject: (path, text) => ipcRenderer.invoke('project:write', path, text),
  projectExists: (path) => ipcRenderer.invoke('project:exists', path),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  onOpenProject: (cb) => ipcRenderer.on('open-project', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  ready: () => ipcRenderer.send('renderer-ready'),
});
