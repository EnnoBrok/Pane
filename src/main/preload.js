const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('pane', {
  // launcher
  listServers: () => ipcRenderer.invoke('servers:list'),
  onServers: on('servers:update'),
  unhideServer: (serverId) => ipcRenderer.invoke('servers:unhide', serverId),
  listNet: () => ipcRenderer.invoke('net:list'),
  onNet: on('net:update'),
  addNet: (input) => ipcRenderer.invoke('net:add', input),
  discover: () => ipcRenderer.invoke('net:discover'),
  onDiscoverProgress: on('net:discover-progress'),
  onDiscoverOpen: on('home:discover'),
  rename: (serverId, name) => ipcRenderer.invoke('app:rename', serverId, name),
  tileMenu: (serverId) => ipcRenderer.invoke('tile:menu', serverId),
  onRename: on('tile:rename'),
  onFocusSearch: on('home:focus'),
  homeMenu: () => ipcRenderer.invoke('home:menu'),
  getView: () => ipcRenderer.invoke('view:get'),
  onView: on('view:update'),
  setLayout: (layout) => ipcRenderer.invoke('view:layout', layout),
  wantThumbs: (serverIds) => ipcRenderer.invoke('thumbs:want', serverIds),
  listPasswords: () => ipcRenderer.invoke('pw:list'),
  onPasswords: on('pw:update'),
  removePassword: (id) => ipcRenderer.invoke('pw:remove', id),
  // tabs
  openTab: (serverId, other = false) => ipcRenderer.invoke('tab:open', serverId, other),
  activateTab: (tabId) => ipcRenderer.invoke('tab:activate', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  tabMenu: (tabId) => ipcRenderer.invoke('tab:menu', tabId),
  retryTab: (tabId) => ipcRenderer.invoke('tab:retry', tabId),
  onTabs: on('tabs:update'),
  // title strip of an app window
  getFrame: (tabId) => ipcRenderer.invoke('frame:get', tabId),
  onFrame: on('frame:update'),
  setChromeColor: (color, symbolColor) => ipcRenderer.invoke('chrome:color', { color, symbolColor }),
  resized: () => ipcRenderer.invoke('chrome:resized'),
});
