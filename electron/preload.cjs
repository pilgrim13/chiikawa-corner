const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('corner', {
  getConfig: () => ipcRenderer.invoke('corner:config'),
  setOverlay: (state) => ipcRenderer.send('corner:overlay-state', state),
  onOverlay: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('corner:overlay-state', handler);
    ipcRenderer.invoke('corner:overlay-current').then(callback);
    return () => ipcRenderer.removeListener('corner:overlay-state', handler);
  },
  setMousePassthrough: (ignore) => ipcRenderer.send('corner:mouse-passthrough', ignore),
  openPanel: () => ipcRenderer.send('corner:open-panel'),
  hidePanel: () => ipcRenderer.send('corner:hide-panel'),
  toggleOverlay: () => ipcRenderer.invoke('corner:toggle-overlay'),
  copyText: (text) => ipcRenderer.invoke('corner:copy', text),
  getDisplays: () => ipcRenderer.invoke('corner:displays'),
  selectDisplay: (id) => ipcRenderer.invoke('corner:select-display', id),
  getUpdateState: () => ipcRenderer.invoke('corner:update-state'),
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('corner:update-state', handler);
    return () => ipcRenderer.removeListener('corner:update-state', handler);
  },
  checkForUpdate: () => ipcRenderer.invoke('corner:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('corner:update-download'),
  installUpdate: () => ipcRenderer.invoke('corner:update-install'),
});
