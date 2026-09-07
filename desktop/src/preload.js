"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("launcher", {
  appInfo: invoke("app:info"),
  getConfig: invoke("config:get"),
  saveConfig: invoke("config:save"),
  importLegacyKey: invoke("config:importLegacyKey"),
  pickFolder: invoke("dialog:pickFolder"),
  runSetup: invoke("setup:run"),
  downloadTunnelClient: invoke("tunnel:download"),
  getStatus: invoke("status:get"),
  getSkillCatalog: invoke("skills:catalog"),
  saveSkillCatalog: invoke("skills:save"),
  pickSkillFile: invoke("skills:pickFile"),
  pickSkillFolder: invoke("skills:pickFolder"),
  pickSkillZip: invoke("skills:pickZip"),
  inspectSkillSource: invoke("skills:inspectSource"),
  discardSkillSource: invoke("skills:discardSource"),
  installSkill: invoke("skills:install"),
  uninstallSkill: invoke("skills:uninstall"),
  setSkillEnabled: invoke("skills:setEnabled"),
  setComputerUseEnabled: invoke("skills:setComputerUse"),
  resetProfiles: invoke("profiles:reset"),
  uninstallApp: invoke("app:uninstall"),
  startAll: invoke("services:startAll"),
  stopAll: invoke("services:stopAll"),
  startMcp: invoke("mcp:start"),
  stopMcp: invoke("mcp:stop"),
  restartMcp: invoke("mcp:restart"),
  startTunnel: invoke("tunnel:start"),
  stopTunnel: invoke("tunnel:stop"),
  stopExternal: invoke("services:stopExternal"),
  getLogs: invoke("logs:get"),
  clearLogs: invoke("logs:clear"),
  openLogFile: invoke("logs:openFile"),
  openExternal: invoke("shell:openExternal"),
  openLogsFolder: invoke("shell:openLogs"),
  openRuntimeFolder: invoke("shell:openRuntime"),
  copyText: invoke("clipboard:copy"),
  on(channel, callback) {
    const allowed = new Set(["status", "log", "setup:progress", "notice"]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
