'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dashboardWidget', {
  widget: {
    getState: () => ipcRenderer.invoke('widget:get-state'),
    refresh: () => ipcRenderer.invoke('widget:refresh'),
    openSettings: () => ipcRenderer.invoke('widget:open-settings'),
    quit: () => ipcRenderer.invoke('widget:quit'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('widget:state', listener);
      return () => ipcRenderer.removeListener('widget:state', listener);
    },
    onPreview: (callback) => {
      const listener = (_event, config) => callback(config);
      ipcRenderer.on('widget:preview', listener);
      return () => ipcRenderer.removeListener('widget:preview', listener);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    saveAppearance: (input) => ipcRenderer.invoke('settings:save', input),
    saveConnection: (input) => ipcRenderer.invoke('settings:save-connection', input),
    preview: (input) => ipcRenderer.invoke('settings:preview', input),
    openDashboard: () => ipcRenderer.invoke('settings:open-dashboard'),
    cancel: () => ipcRenderer.invoke('settings:cancel'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('settings:state', listener);
      return () => ipcRenderer.removeListener('settings:state', listener);
    }
  }
});
