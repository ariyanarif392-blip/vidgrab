'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['job:update', 'job:remove', 'job:focus', 'update:status', 'ext:status']);

contextBridge.exposeInMainWorld('api', {
  jobs: () => inv('jobs:list'),
  add: (url) => inv('jobs:add', url),
  setQuality: (id, q) => inv('job:quality', id, q),
  start: (id) => inv('job:start', id),
  pause: (id) => inv('job:pause', id),
  cancel: (id) => inv('job:cancel', id),
  remove: (id) => inv('job:remove', id),
  reveal: (id) => inv('job:reveal', id),
  openFile: (id) => inv('job:open', id),

  getSettings: () => inv('settings:get'),
  saveSettings: (s) => inv('settings:save', s),
  pickDir: () => inv('settings:pickDir'),

  browsers: () => inv('browser:list'),
  setupBrowser: (id) => inv('browser:setup', id),
  extStatus: () => inv('browser:status'),

  checkTools: () => inv('tools:check'),
  installTools: () => inv('tools:install'),
  updateYtdlp: () => inv('tools:updateYtdlp'),

  version: () => inv('app:version'),
  checkUpdate: () => inv('update:check'),
  downloadUpdate: () => inv('update:download'),
  installUpdate: () => inv('update:install'),

  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
