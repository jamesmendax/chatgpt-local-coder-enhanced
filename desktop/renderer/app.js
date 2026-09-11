/* global launcher */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  info: null,
  accounts: null,
  accountId: null,
  accountSwitching: false,
  config: null,
  status: null,
  logs: { mcp: [], tunnel: [], launcher: [] },
  activeLog: "mcp",
  view: "dashboard",
  skills: null,
  registrations: [],
  install: null,
};
const MAX_DOM_LINES = 3000;
let logViewDirty = false;
let pendingLogLines = 0;
const ACCOUNT_METHODS = new Set(["listAccounts", "createAccount", "selectAccount", "renameAccount"]);
let accountDialogResolve = null;

function toast(message, level = "info", ttl = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

async function call(name, payload) {
  const scoped = !ACCOUNT_METHODS.has(name);
  const requestAccount = scoped ? state.accountId : null;
  let requestPayload = payload;
  if (scoped && requestAccount) {
    requestPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload, _accountId: requestAccount }
      : { _accountId: requestAccount };
  }
  const res = await launcher[name](requestPayload);
  if (!res.ok) throw new Error(res.error || "未知错误");
  if (scoped && requestAccount && state.accountId !== requestAccount) {
    const error = new Error("账号已切换，已忽略上一账号的返回结果。");
    error.code = "STALE_ACCOUNT_RESPONSE";
    throw error;
  }
  if (scoped && requestAccount && res.accountId && res.accountId !== requestAccount) {
    throw new Error("返回结果账号不匹配，已阻止更新界面。");
  }
  return res.result;
}

function activeAccount() {
  return state.accounts?.accounts?.find((row) => row.id === state.accountId) || null;
}

function shortAccountId(id) {
  return id === "default" ? "default" : String(id || "").slice(0, 8);
}

function accountServiceSummary(row) {
  const mcp = row?.mcp?.owned ? "MCP 运行中" : "MCP 已停";
  const tunnel = row?.tunnel?.owned ? "隧道 运行中" : "隧道 已停";
  return `${mcp} · ${tunnel}`;
}

function renderAccounts(accounts = state.accounts) {
  if (!accounts) return;
  state.accounts = accounts;
  const select = $("account-select");
  const previous = state.accountId || accounts.selectedId;
  select.textContent = "";
  for (const row of accounts.accounts || []) {
    const option = document.createElement("option");
    option.value = row.id;
    const running = row.mcp?.owned || row.tunnel?.owned ? " ●" : "";
    option.textContent = `${row.name}${running}`;
    select.appendChild(option);
  }
  if ((accounts.accounts || []).some((row) => row.id === previous)) select.value = previous;
  select.disabled = state.accountSwitching;
  $("btn-account-create").disabled = state.accountSwitching || (accounts.accounts || []).length >= (accounts.maxAccounts || 16);
  $("btn-account-rename").disabled = state.accountSwitching || !activeAccount();
  const row = activeAccount();
  if (!row) return;
  $("account-meta").textContent = `${shortAccountId(row.id)}\n${accountServiceSummary(row)}`;
  $("account-meta").title = `${row.dataDir || ""}\n${accounts.securityBoundary || ""}`;
  $("dashboard-account-name").textContent = row.name;
  $("dashboard-account-id").textContent = shortAccountId(row.id);
  $("dashboard-account-detail").textContent = row.config?.workspacePath || "尚未设置工作区";
  $("dashboard-account-endpoints").textContent = `MCP ${row.config?.mcpPort || "—"} · Admin ${row.config?.adminPort || "—"} · Tunnel ${row.config?.tunnelPort || "—"}`;
  $("setup-account-name").textContent = row.name;
  $("guide-account-name").textContent = row.name;
  $("guide-connector-name").textContent = `Web Harness · ${row.name}`;
}

async function reloadCurrentAccount({ navigate = false } = {}) {
  const expected = state.accountId;
  // Establish window/app identity before the rest of account initialization so
  // a malformed config cannot leave an anonymous error window.
  const info = await call("appInfo");
  if (state.accountId !== expected) return;
  state.info = info;
  document.title = appIdentity();
  $("page-subtitle").textContent = appIdentity();
  const [config, logs, status] = await Promise.all([
    call("getConfig"), call("getLogs"), call("getStatus"),
  ]);
  if (state.accountId !== expected) return;
  state.config = config;
  state.logs = logs;
  state.skills = null;
  state.registrations = [];
  state.install = null;
  pendingLogLines = 0;
  logViewDirty = true;
  renderLog(state.activeLog);
  renderStatus(status);
  fillSetupForm();
  renderAccounts();
  if (navigate) {
    showView(config.setupDone ? "dashboard" : "settings");
    if (!config.setupDone) showSettingsTab("setup");
  } else {
    showView(state.view);
  }
}

async function switchAccount(id) {
  if (!id || id === state.accountId || state.accountSwitching) return;
  const previous = state.accountId;
  state.accountSwitching = true;
  renderAccounts();
  try {
    const result = await call("selectAccount", { id });
    state.accountId = result.selectedId;
    state.accounts = result;
    clearInstallPanel(false);
    await reloadCurrentAccount({ navigate: true });
    toast(`已切换到 ${activeAccount()?.name || shortAccountId(state.accountId)}；其他账号的运行服务保持不变。`, "success", 4500);
  } catch (err) {
    state.accountId = previous;
    if (err.code !== "STALE_ACCOUNT_RESPONSE") toast(err.message, "error", 9000);
  } finally {
    state.accountSwitching = false;
    renderAccounts();
  }
}

function closeAccountDialog(value = null) {
  const dialog = $("account-dialog");
  if (dialog.open) dialog.close();
  const resolve = accountDialogResolve;
  accountDialogResolve = null;
  if (resolve) resolve(value);
}

function requestAccountName({ title, description, value = "", submitLabel }) {
  if (accountDialogResolve) closeAccountDialog(null);
  $("account-dialog-title").textContent = title;
  $("account-dialog-description").textContent = description;
  $("account-dialog-submit").textContent = submitLabel;
  $("account-dialog-name").value = value;
  $("account-dialog").showModal();
  requestAnimationFrame(() => {
    $("account-dialog-name").focus();
    $("account-dialog-name").select();
  });
  return new Promise((resolve) => { accountDialogResolve = resolve; });
}

async function createAccountProfile() {
  if (state.accountSwitching) return;
  const name = await requestAccountName({
    title: "新建账号",
    description: "创建一个与其他 ChatGPT 账号完全独立的本地配置档。",
    value: `账号 ${(state.accounts?.accounts?.length || 0) + 1}`,
    submitLabel: "创建账号",
  });
  if (name == null) return;
  state.accountSwitching = true;
  renderAccounts();
  try {
    const created = await call("createAccount", { name });
    const selected = await call("selectAccount", { id: created.id });
    state.accountId = selected.selectedId;
    state.accounts = selected;
    await reloadCurrentAccount({ navigate: true });
    showView("settings");
    showSettingsTab("setup");
    toast("新账号已创建：端口、配置、运行目录和 Skills 已独立分配；请填写该账号自己的 Tunnel ID 与 Runtime API Key。", "success", 9000);
  } catch (err) {
    toast(err.message, "error", 9000);
    state.accounts = await call("listAccounts").catch(() => state.accounts);
  } finally {
    state.accountSwitching = false;
    renderAccounts();
  }
}

async function renameAccountProfile() {
  const row = activeAccount();
  if (!row || state.accountSwitching) return;
  const name = await requestAccountName({
    title: "重命名账号",
    description: "只修改显示名称，不移动该账号的配置、密钥、运行目录或 Skills。",
    value: row.name,
    submitLabel: "保存名称",
  });
  if (name == null || name.trim() === row.name) return;
  try {
    state.accounts = await call("renameAccount", { id: row.id, name });
    renderAccounts();
    state.info = await call("appInfo");
    showView(state.view);
    toast("账号已重命名；配置、密钥和运行目录未移动。", "success", 4000);
  } catch (err) {
    toast(err.message, "error", 9000);
  }
}

function appIdentity() {
  return `${state.info.name || "ChatGPT Web Harness"} · v${state.info.version}`;
}

function showView(name) {
  state.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const titles = {
    dashboard: ["控制台", "运行状态与实时活动"],
    skills: ["Skills / 插件", "本地扩展与注册表"],
    settings: ["设置", "初始化、发布与偏好"],
  };
  if (titles[name]) {
    $("page-title").textContent = titles[name][0];
    $("page-subtitle").textContent = state.info ? `${appIdentity()} · ${titles[name][1]}` : titles[name][1];
  }
  if (name === "dashboard") {
    if (logViewDirty) renderLog(state.activeLog, true);
    else if (pendingLogLines) {
      appendLogNodes(state.logs[state.activeLog].slice(-pendingLogLines));
      pendingLogLines = 0;
    }
  }
  if (name === "setup") fillSetupForm();
  if (name === "settings") {
    fillSetupForm();
    $("guide-tunnel-id").textContent = (state.config && state.config.tunnelId) || "（尚未配置）";
  }
  if (name === "skills") loadSkillCatalog().catch((err) => toast(err.message, "error", 8000));
}

function showSettingsTab(name) {
  document.querySelectorAll(".settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.settingsTab === name));
  document.querySelectorAll("#view-settings .settings-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `settings-pane-${name}`);
  });
}

/* ---------- 初始化表单 ---------- */

function fillSetupForm() {
  const c = state.config || {};
  const info = state.info || {};
  $("f-tunnel-id").value = c.tunnelId || info.legacyTunnelId || "";
  $("f-api-key").value = "";
  $("key-hint").textContent = c.hasApiKey ? "（已保存，留空则保持不变）" : "";
  $("f-workspace").value = c.workspacePath || info.legacyWorkspace || "";
  $("f-mcp-port").value = c.mcpPort || 3000;
  $("f-tunnel-port").value = c.tunnelPort || 8080;
  $("f-tunnel-proxy-mode").value = c.tunnelProxyMode || "auto";
  $("f-tunnel-proxy-url").value = c.tunnelProxyUrl || "";
  $("f-tunnel-proxy-url").disabled = $("f-tunnel-proxy-mode").value !== "custom";
  $("f-admin-port").value = c.adminPort || 3001;
  $("f-tool-profile").value = c.toolProfile || "slim";
  $("f-auto-start").checked = Boolean(c.autoStart);
  $("f-tray").checked = c.minimizeToTray !== false;

  const legacyRow = $("legacy-import-row");
  const holder = $("legacy-import-buttons");
  holder.innerHTML = "";
  if (info.legacyKeys && info.legacyKeys.length) {
    legacyRow.hidden = false;
    for (const label of info.legacyKeys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost small";
      btn.textContent = `导入 ${label} 密钥`;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await call("importLegacyKey", { label });
          state.config = await call("getConfig");
          $("key-hint").textContent = "（已从旧密钥导入并保存）";
          toast(`已导入 ${label} 的 Runtime API Key`, "success");
        } catch (err) {
          toast(err.message, "error", 8000);
        } finally {
          btn.disabled = false;
        }
      });
      holder.appendChild(btn);
    }
  } else {
    legacyRow.hidden = true;
  }
}

function readSetupForm() {
  return {
    tunnelId: $("f-tunnel-id").value.trim(),
    apiKey: $("f-api-key").value,
    workspacePath: $("f-workspace").value.trim(),
    mcpPort: Number($("f-mcp-port").value),
    tunnelPort: Number($("f-tunnel-port").value),
    tunnelProxyMode: $("f-tunnel-proxy-mode").value,
    tunnelProxyUrl: $("f-tunnel-proxy-url").value.trim(),
    adminPort: Number($("f-admin-port").value),
    toolProfile: $("f-tool-profile").value,
    autoStart: $("f-auto-start").checked,
    minimizeToTray: $("f-tray").checked,
    skipDoctor: $("f-skip-doctor").checked,
  };
}

function setupProgress(title, line, reset = false) {
  const box = $("setup-progress");
  box.hidden = false;
  if (title) $("setup-progress-title").textContent = title;
  const log = $("setup-progress-log");
  if (reset) log.textContent = "";
  if (line) {
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  }
}

async function runSetup(event) {
  event.preventDefault();
  const payload = readSetupForm();
  if (!payload.tunnelId) return toast("请填写 Tunnel ID", "error");
  if (!payload.apiKey && !(state.config && state.config.hasApiKey)) return toast("请填写 Runtime API Key", "error");
  const btn = $("btn-run-setup");
  btn.disabled = true;
  setupProgress("初始化中…", "开始初始化", true);
  try {
    const result = await call("runSetup", payload);
    $("f-api-key").value = "";
    state.config = await call("getConfig");
    if (result.ok) {
      setupProgress("初始化完成 ✔", result.doctor ? `doctor:\n${result.doctor}` : "");
      toast("初始化完成，接下来请在 ChatGPT 网页端发布应用。", "success", 7000);
      showView("settings");
      showSettingsTab("guide");
    } else {
      setupProgress("校验失败 ✘", `${result.message}\n${result.doctor || ""}`);
      toast(result.message, "error", 9000);
    }
  } catch (err) {
    setupProgress("初始化失败 ✘", err.message);
    toast(err.message, "error", 9000);
  } finally {
    btn.disabled = false;
  }
}

async function saveOnly() {
  const payload = readSetupForm();
  try {
    state.config = await call("saveConfig", payload);
    $("f-api-key").value = "";
    fillSetupForm();
    toast("设置已保存", "success");
  } catch (err) {
    toast(err.message, "error", 8000);
  }
}

/* ---------- Skills / 插件 ---------- */

let skillCatalogRequest = 0;
let savingSkills = false;

function captureSkillDraft() {
  return {
    // Compare raw editor values, not collectRegistrations()'s trimmed save payload.
    registrations: JSON.stringify([...document.querySelectorAll("#registered-skills-list .skill-row")].map((row) => [
      row.querySelector('[data-field="name"]').value,
      row.querySelector(".skill-path").textContent,
      row.querySelector('[data-field="enabled"]').checked,
    ])),
    computerUseEnabled: $("chk-computer-use").checked,
  };
}

async function loadSkillCatalog() {
  if (savingSkills) return;
  const request = ++skillCatalogRequest;
  const previousCatalog = state.skills;
  const draft = captureSkillDraft();
  const catalog = await call("getSkillCatalog");
  // A save, newer refresh, or accepted mutation takes precedence over this read.
  if (savingSkills || request !== skillCatalogRequest || state.skills !== previousCatalog) return;
  state.skills = catalog;
  state.registrations = (state.skills.external || state.skills.registered || []).map((skill) => ({
    id: skill.id || skill.name,
    name: skill.id || skill.name,
    path: skill.path,
    enabled: skill.enabled !== false,
    error: skill.error || "",
    description: skill.description || "",
  }));
  renderSkillCatalog(draft);
}

function renderSkillList(holder, skills, source, removable) {
  holder.textContent = "";
  const rows = Array.isArray(skills) ? skills : [];
  if (!rows.length) {
    holder.appendChild(emptyNode("未发现"));
    return;
  }
  for (const skill of rows) holder.appendChild(actionSkillRow(skill, source, removable));
}

function renderMutableSkillLists() {
  const catalog = state.skills || {};
  renderSkillList($("installed-skills-list"), catalog.installed, "installed", true);
  renderSkillList($("builtin-skills-list"), catalog.builtin, "builtin", false);
}

function renderExternalSkillList() {
  const holder = $("registered-skills-list");
  holder.textContent = "";
  const rows = Array.isArray(state.registrations) ? state.registrations : [];
  if (!rows.length) {
    holder.appendChild(emptyNode("保存后将清空外部注册。"));
    return;
  }
  for (const skill of rows) holder.appendChild(registeredSkillRow(skill));
}

function renderSkillCatalog(draft = null) {
  const currentDraft = draft && captureSkillDraft();
  const keepRegistrations = Boolean(draft && draft.registrations !== currentDraft.registrations);
  const catalog = state.skills || {};
  const computerUse = catalog.computerUse || {};
  const toggle = $("chk-computer-use");
  if (!draft || draft.computerUseEnabled === currentDraft.computerUseEnabled) {
    toggle.checked = computerUse.enabled === true;
  }
  toggle.disabled = computerUse.available === false;
  toggle.title = computerUse.available === false ? "当前环境没有可用的 Computer Use Skill" : "";

  const configPath = $("skills-config-path");
  configPath.textContent = catalog.configPath || "profiles/plugins.json";
  configPath.title = catalog.configPath || "";

  renderMutableSkillLists();
  // Preserve row identity/focus as well as edits made while the IPC was pending.
  if (!keepRegistrations) renderExternalSkillList();
  renderDiscoveredSkills($("project-skills-list"), catalog.project);
  return keepRegistrations;
}

function emptyNode(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  return div;
}

function skillTitle(skill) {
  const holder = document.createElement("div");
  holder.className = "skill-title";
  const name = document.createElement("b");
  name.textContent = skill.id || skill.name;
  holder.appendChild(name);
  for (const [label, value, cls] of [
    ["别名", skill.aliases?.join(", "), "skill-badge"],
    ["版本", skill.version, "skill-badge"],
    ["警告", skill.warnings?.length ? skill.warnings.join("；") : "", "skill-badge warning"],
    ["被覆盖", skill.shadowedBy ? "被 " + skill.shadowedBy + " 覆盖" : "", "skill-badge warning"],
  ]) {
    if (!value) continue;
    const badge = document.createElement("span");
    badge.className = cls;
    badge.textContent = label + ": " + value;
    badge.title = badge.textContent;
    holder.appendChild(badge);
  }
  return holder;
}

function actionSkillRow(skill, source, removable) {
  const row = document.createElement("div");
  row.className = "skill-row";
  row.appendChild(skillTitle(skill));

  const info = document.createElement("div");
  const desc = document.createElement("div");
  desc.className = skill.error ? "skill-error" : "skill-desc";
  desc.textContent = skill.error || skill.description || "—";
  desc.title = desc.textContent;
  const pathNode = document.createElement("div");
  pathNode.className = "skill-path";
  pathNode.textContent = skill.path || "—";
  pathNode.title = skill.path || "";
  info.append(desc, pathNode);
  row.appendChild(info);

  const sourceNode = document.createElement("div");
  sourceNode.className = "small muted";
  sourceNode.textContent = source;
  row.appendChild(sourceNode);

  const actions = document.createElement("div");
  actions.className = "skill-actions";
  const enabled = document.createElement("label");
  enabled.className = "switch";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = skill.enabled !== false;
  checkbox.disabled = Boolean(skill.error);
  const slider = document.createElement("span");
  enabled.append(checkbox, slider);
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    try {
      const result = await call("setSkillEnabled", { id: skill.id || skill.name, source, enabled: checkbox.checked });
      state.skills = result.catalog;
      renderMutableSkillLists();
      toast((skill.id || skill.name) + " 已" + (checkbox.checked ? "启用" : "禁用"), "success", 2500);
    } catch (err) {
      checkbox.checked = !checkbox.checked;
      checkbox.disabled = false;
      toast(err.message, "error", 8000);
    }
  });
  actions.appendChild(enabled);
  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet-danger small";
    remove.textContent = "卸载";
    remove.addEventListener("click", async () => {
      if (!confirm("确定卸载 Skill「" + (skill.id || skill.name) + "」？")) return;
      try {
        const result = await call("uninstallSkill", { id: skill.id || skill.name });
        state.skills = result.catalog;
        renderMutableSkillLists();
        toast("Skill 已卸载", "success", 3000);
      } catch (err) {
        toast(err.message, "error", 9000);
      }
    });
    actions.appendChild(remove);
  }
  row.appendChild(actions);
  return row;
}

function registeredSkillRow(skill) {
  const row = document.createElement("div");
  row.className = "skill-row";
  const name = document.createElement("input");
  name.type = "text";
  name.value = skill.id || skill.name || "";
  name.title = "Skill id";
  name.dataset.field = "name";
  const info = document.createElement("div");
  const desc = document.createElement("div");
  desc.className = skill.error ? "skill-error" : "skill-desc";
  desc.textContent = skill.error || skill.description || "保存时读取 SKILL.md";
  const pathNode = document.createElement("div");
  pathNode.className = "skill-path";
  pathNode.textContent = skill.path || "";
  pathNode.title = skill.path || "";
  info.append(desc, pathNode);
  row.append(name, info);
  const source = document.createElement("div");
  source.className = "small muted";
  source.textContent = "external";
  row.appendChild(source);
  const enabled = document.createElement("label");
  enabled.className = "switch";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = skill.enabled !== false;
  checkbox.dataset.field = "enabled";
  const slider = document.createElement("span");
  enabled.append(checkbox, slider);
  const externalActions = document.createElement("div");
  externalActions.className = "skill-actions";
  externalActions.appendChild(enabled);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet-danger small";
  remove.textContent = "移除";
  remove.addEventListener("click", () => {
    row.remove();
    if (!$("registered-skills-list").querySelector(".skill-row")) {
      $("registered-skills-list").appendChild(emptyNode("保存后将清空外部注册。"));
    }
  });
  externalActions.appendChild(remove);
  row.appendChild(externalActions);
  return row;
}

function renderDiscoveredSkills(holder, skills = []) {
  holder.textContent = "";
  if (!skills.length) {
    holder.appendChild(emptyNode("未发现"));
    return;
  }
  for (const skill of skills) {
    const row = document.createElement("div");
    row.className = "skill-row";
    const title = skillTitle(skill);
    const desc = document.createElement("div");
    desc.className = skill.error ? "skill-error" : "skill-desc";
    desc.textContent = skill.error || skill.description || "—";
    desc.title = desc.textContent;
    const pathNode = document.createElement("div");
    pathNode.className = "skill-path";
    pathNode.textContent = skill.path || "—";
    pathNode.title = skill.path || "";
    const source = document.createElement("div");
    source.className = "small muted";
    source.textContent = skill.source;
    row.append(title, desc, pathNode, source);
    holder.appendChild(row);
  }
}

function collectRegistrations() {
  const rows = document.querySelectorAll("#registered-skills-list .skill-row");
  const out = [];
  for (const row of rows) {
    const name = row.querySelector('[data-field="name"]');
    const enabled = row.querySelector('[data-field="enabled"]');
    const pathNode = row.querySelector(".skill-path");
    if (!name || !pathNode || !pathNode.textContent.trim()) continue;
    out.push({ id: name.value.trim(), path: pathNode.textContent.trim(), enabled: enabled.checked });
  }
  return out;
}

async function saveSkills() {
  if (savingSkills) return;
  const button = $("btn-skills-save");
  savingSkills = true;
  ++skillCatalogRequest;
  button.disabled = true;
  try {
    const draft = captureSkillDraft();
    const result = await call("saveSkillCatalog", {
      registrations: collectRegistrations(),
      computerUseEnabled: $("chk-computer-use").checked,
    });
    state.skills = result.catalog;
    state.registrations = (state.skills.external || []).map((skill) => ({
      id: skill.id,
      name: skill.id,
      path: skill.path,
      enabled: skill.enabled !== false,
      error: skill.error || "",
      description: skill.description || "",
    }));
    const keptEdits = renderSkillCatalog(draft);
    toast(keptEdits ? "已保存提交时的外部 Skill 配置；后续编辑尚未保存。" : "外部 Skill 配置已保存。", "success", 5000);
  } catch (err) {
    toast(err.message, "error", 9000);
  } finally {
    savingSkills = false;
    button.disabled = false;
  }
}

function clearInstallPanel(discard = true) {
  if (discard && state.install?.source) launcher.discardSkillSource({ source: state.install.source }).catch(() => {});
  state.install = null;
  $("install-skill-panel").hidden = true;
  $("install-skill-source").textContent = "—";
  $("install-skill-details").textContent = "";
  $("install-skill-warnings").textContent = "";
}

async function inspectInstallSource(source) {
  try {
    clearInstallPanel();
    const inspected = await call("inspectSkillSource", { source });
    state.install = { source: inspected.source, inspected };
    $("install-skill-panel").hidden = false;
    $("install-skill-source").textContent = inspected.root + "\n" + inspected.skillPath;
    $("f-install-id").value = inspected.id || "";
    const alias = inspected.aliases?.length ? "别名: " + inspected.aliases.join(", ") : "无 frontmatter 别名";
    let details = (inspected.description || "未提供 description") + " · " + alias;
    if (inspected.version) details += " · 版本: " + inspected.version;
    $("install-skill-details").textContent = details;
    $("install-skill-warnings").textContent = inspected.warnings?.length ? "依赖提示：" + inspected.warnings.join("；") : "依赖检查未发现阻塞项。";
  } catch (err) {
    toast(err.message, "error", 9000);
  }
}

async function confirmInstall() {
  if (!state.install) return;
  const button = $("btn-install-confirm");
  button.disabled = true;
  try {
    const result = await call("installSkill", {
      source: state.install.source,
      id: $("f-install-id").value.trim(),
      overwrite: true,
    });
    state.skills = result.catalog;
    renderMutableSkillLists();
    clearInstallPanel(false);
    toast("已安装 " + result.result.id, "success", 5000);
  } catch (err) {
    toast(err.message, "error", 9000);
  } finally {
    button.disabled = false;
  }
}

/* ---------- 控制台 ---------- */

/** 状态只通过一个低饱和圆点表达，文字保持中性，避免整块红绿。 */
function setState(el, cls, text) {
  const dot = el.querySelector(".dot");
  const label = el.querySelector("[data-label]");
  if (dot) dot.className = `dot ${cls}`;
  if (label) label.textContent = text;
}
const badge = setState;
const pill = setState;

function renderStatus(s) {
  state.status = s;
  state.config = s.config;
  const m = s.mcp;
  const t = s.tunnel;
  const cfg = s.config;

  // MCP
  let mcpCls = "err";
  let mcpText = "未运行";
  if (m.managed && m.state === "starting") { mcpCls = "busy"; mcpText = "启动中"; }
  else if (m.managed && m.state === "stopping") { mcpCls = "busy"; mcpText = "停止中"; }
  else if (m.healthy && m.staleBuild) { mcpCls = "warn"; mcpText = "运行中（旧构建）"; }
  else if (m.healthy) { mcpCls = "ok"; mcpText = "运行中"; }
  else if (m.portOccupiedByUnknown) { mcpCls = "warn"; mcpText = "端口被占用"; }
  else if (m.state === "error") { mcpCls = "err"; mcpText = "异常退出"; }
  badge($("badge-mcp"), mcpCls, mcpText);
  pill($("pill-mcp"), mcpCls, `MCP · ${mcpText}`);
  $("mcp-source").textContent = m.managed ? "本启动器" : (m.healthy ? "外部进程（旧脚本/手动启动）" : "—");
  $("mcp-pid").textContent = m.pid || "—";
  $("mcp-build").textContent = m.build || "—";
  $("mcp-tools").textContent = m.toolCount != null ? `${m.toolCount}（${m.toolProfile}）` : "—";
  $("mcp-stale").textContent = m.staleBuild == null ? "—" : (m.staleBuild ? "需重启更新" : "当前构建");
  $("mcp-auth").textContent = m.auth || "—";

  // Tunnel。注意 /readyz 只代表本地链路，凭据是否被接受要看 authError。
  let tCls = "err";
  let tText = "未运行";
  if (t.managed && t.state === "starting") { tCls = "busy"; tText = "连接中"; }
  else if (t.managed && t.state === "stopping") { tCls = "busy"; tText = "停止中"; }
  else if (t.authError) { tCls = "err"; tText = "凭据被拒 (401)"; }
  else if (t.metaError || t.cloudState === "error") { tCls = "warn"; tText = "云端连接异常"; }
  else if (t.ready && t.cloudState === "online") { tCls = "ok"; tText = "云端已连接"; }
  else if (t.ready && t.cloudState === "stale") { tCls = "warn"; tText = "轮询状态过期"; }
  else if (t.ready) { tCls = "warn"; tText = "本地就绪 · 云端待确认"; }
  else if (t.reachable) { tCls = "warn"; tText = "未就绪"; }
  else if (t.portOccupiedByUnknown) { tCls = "warn"; tText = "端口被占用"; }
  else if (t.state === "error") { tCls = "err"; tText = "异常退出"; }
  badge($("badge-tunnel"), tCls, tText);
  pill($("pill-tunnel"), tCls, `Tunnel · ${tText}`);
  $("tunnel-source").textContent = t.managed ? "本启动器" : (t.ready ? "外部进程（旧脚本/手动启动）" : "—");
  $("tunnel-pid").textContent = t.pid || "—";
  $("tunnel-id").textContent = cfg.tunnelId || "（未配置）";
  $("tunnel-id").title = cfg.tunnelId || "";
  $("tunnel-port").textContent = cfg.tunnelPort;
  $("tunnel-ready").textContent = t.ready ? "已就绪（仅本地）" : (t.reachable ? "尚未就绪" : "不可达");
  $("tunnel-ready").title = "此接口只证明 Tunnel 能连接本地 MCP，不代表云端可用。";
  const cloudError = t.authError || t.metaError;
  $("tunnel-cloud").textContent = cloudError ? (t.authError ? "认证失败，请检查 Runtime Key/Tunnel ID" : "连接中断，正在退避重试；请检查代理/网络")
    : t.cloudState === "online" ? `最近成功：${new Date(t.lastPollSuccessAt).toLocaleTimeString()}`
    : t.cloudState === "stale" ? "长时间未收到成功轮询，请检查代理/网络"
    : t.ready ? "等待首轮成功（通常约 30 秒）" : "尚未连接";
  $("tunnel-cloud").title = cloudError ? cloudError.line : "以真实成功轮询指标为准，不以进程存在或 readyz 冒充在线。";
  const route = t.proxyRoute;
  $("tunnel-route").textContent = route ? (route.mode === "proxy" ? `代理 · ${route.url}` : "直连") : "—";
  $("tunnel-route").title = route ? `策略来源：${route.source || "tunnel-client"}；本地 MCP 直连` : "";
  $("tunnel-workspace").textContent = cfg.workspacePath || "—";
  $("tunnel-workspace").title = cfg.workspacePath || "";

  // 按钮可用性
  const busy = s.busy;
  const setupDone = cfg.setupDone;
  $("setup-required").hidden = setupDone;
  $("btn-configure-account").textContent = setupDone ? "账号设置" : "完成配置";
  $("btn-start-all").disabled = busy || !setupDone || (m.healthy && t.ready);
  $("btn-stop-all").disabled = busy || !(m.managed || t.managed);
  const externalDisabled = Boolean(state.info?.isolated || state.info?.multiAccount);
  $("btn-stop-external").hidden = externalDisabled;
  $("btn-stop-external").disabled = externalDisabled || busy || !((m.external && m.externalRecognized) || (t.external && t.externalRecognized));
  $("btn-mcp-start").disabled = busy || !setupDone || m.healthy;
  $("btn-mcp-stop").disabled = busy || !m.managed;
  $("btn-mcp-restart").disabled = busy || !setupDone || (m.healthy && !m.managed);
  $("btn-tunnel-start").disabled = busy || !setupDone || t.ready;
  $("btn-tunnel-stop").disabled = busy || !t.managed;

  $("footer").textContent = `${s.paths.codeRoot}  ·  运行目录 ${s.paths.runtimeDir}  ·  ${new Date(s.at).toLocaleTimeString()}`;
}

function appendLogLines(name, lines) {
  if (!lines.length) return;
  const buf = state.logs[name];
  buf.push(...lines);
  if (buf.length > MAX_DOM_LINES) buf.splice(0, buf.length - MAX_DOM_LINES);
  if (name !== state.activeLog) return;
  if (state.view !== "dashboard") {
    // Defer DOM work, retaining only a count into the already bounded buffer.
    pendingLogLines = Math.min(MAX_DOM_LINES, pendingLogLines + lines.length);
    return;
  }
  appendLogNodes(lines);
}

function appendLogNodes(lines) {
  const view = $("log-view");
  const frag = document.createDocumentFragment();
  for (const line of lines) frag.appendChild(lineNode(line));
  view.appendChild(frag);
  while (view.childNodes.length > MAX_DOM_LINES) view.removeChild(view.firstChild);
  if ($("log-autoscroll").checked) view.scrollTop = view.scrollHeight;
}

function lineNode(line) {
  const span = document.createElement("span");
  const isErr = /^\d\d:\d\d:\d\d ! /.test(line) || /error|fail|exception/i.test(line);
  if (isErr) span.className = "err";
  span.textContent = `${line}\n`;
  return span;
}

const LOG_HINTS = {
  mcp: "进程输出 + Admin API /api/activity（ChatGPT 的每次工具调用）",
  tunnel: "进程输出 + tunnel-client /api/logs（控制平面轮询与命令派发）",
  launcher: "启动器自身的动作与告警",
};

function renderLog(name, keepScroll = false) {
  state.activeLog = name;
  pendingLogLines = 0;
  $("log-hint").textContent = LOG_HINTS[name] || "";
  $("btn-open-log-file").disabled = name === "launcher";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.log === name));
  if (state.view !== "dashboard") {
    logViewDirty = true;
    return;
  }
  const view = $("log-view");
  const scrollTop = view.scrollTop;
  view.textContent = "";
  const frag = document.createDocumentFragment();
  for (const line of state.logs[name]) frag.appendChild(lineNode(line));
  view.appendChild(frag);
  logViewDirty = false;
  // Tab switches still start at the bottom; returning to the page respects the checkbox.
  view.scrollTop = keepScroll && !$("log-autoscroll").checked ? scrollTop : view.scrollHeight;
}

async function action(name, label) {
  try {
    await call(name);
    if (label) toast(`${label} 完成`, "success", 3000);
  } catch (err) {
    toast(err.message, "error", 9000);
  }
}

function url(pathname) {
  const cfg = state.config || {};
  return pathname
    .replace("{mcp}", cfg.mcpPort || 3000)
    .replace("{admin}", cfg.adminPort || 3001)
    .replace("{tunnel}", cfg.tunnelPort || 8080);
}

function bind() {
  $("account-select").addEventListener("change", (event) => switchAccount(event.target.value));
  $("btn-account-create").addEventListener("click", createAccountProfile);
  $("btn-account-rename").addEventListener("click", renameAccountProfile);
  const showAccountSetup = () => { showView("settings"); showSettingsTab("setup"); };
  $("btn-configure-account").addEventListener("click", showAccountSetup);
  $("btn-setup-required").addEventListener("click", showAccountSetup);
  $("account-dialog-form").addEventListener("submit", (event) => {
    event.preventDefault();
    closeAccountDialog($("account-dialog-name").value);
  });
  $("account-dialog-cancel").addEventListener("click", () => closeAccountDialog(null));
  $("account-dialog-close").addEventListener("click", () => closeAccountDialog(null));
  $("account-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeAccountDialog(null); });
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  document.querySelectorAll("[data-settings-tab]").forEach((b) => b.addEventListener("click", () => showSettingsTab(b.dataset.settingsTab)));
  document.querySelectorAll("[data-url]").forEach((b) => b.addEventListener("click", () => call("openExternal", { url: b.dataset.url }).catch((e) => toast(e.message, "error"))));

  $("setup-form").addEventListener("submit", runSetup);
  $("btn-save-only").addEventListener("click", saveOnly);
  $("btn-toggle-key").addEventListener("click", () => {
    const input = $("f-api-key");
    input.type = input.type === "password" ? "text" : "password";
    $("btn-toggle-key").textContent = input.type === "password" ? "显示" : "隐藏";
  });
  $("btn-pick-workspace").addEventListener("click", async () => {
    const picked = await call("pickFolder", { current: $("f-workspace").value });
    if (picked) $("f-workspace").value = picked;
  });
  $("btn-copy-tunnel").addEventListener("click", () => {
    const id = (state.config && state.config.tunnelId) || "";
    if (!id) return toast("尚未配置 Tunnel ID", "error");
    call("copyText", { text: id }).then(() => toast("Tunnel ID 已复制", "success", 2500));
  });

  $("btn-skills-refresh").addEventListener("click", () => loadSkillCatalog().catch((err) => toast(err.message, "error", 8000)));
  $("btn-skills-save").addEventListener("click", saveSkills);
  $("chk-computer-use").addEventListener("change", async () => {
    const enabled = $("chk-computer-use").checked;
    try {
      const result = await call("setComputerUseEnabled", { enabled });
      state.skills = result.catalog;
      $("chk-computer-use").checked = Boolean(state.skills.computerUse?.enabled);
      toast("Computer Use 配置已保存；新 MCP 会话生效。", "success", 3500);
    } catch (err) {
      $("chk-computer-use").checked = !enabled;
      toast(err.message, "error", 8000);
    }
  });
  $("btn-install-skill-folder").addEventListener("click", async () => {
    try {
      const source = await call("pickSkillFolder");
      if (source) await inspectInstallSource(source);
    } catch (err) {
      toast(err.message, "error", 8000);
    }
  });
  $("btn-install-skill-zip").addEventListener("click", async () => {
    try {
      const source = await call("pickSkillZip");
      if (source) await inspectInstallSource(source);
    } catch (err) {
      toast(err.message, "error", 8000);
    }
  });
  $("btn-install-confirm").addEventListener("click", confirmInstall);
  $("btn-install-cancel").addEventListener("click", () => clearInstallPanel());
  $("btn-install-cancel-2").addEventListener("click", () => clearInstallPanel());
  $("btn-pick-skill").addEventListener("click", async () => {
    try {
      const file = await call("pickSkillFile");
      if (file) $("f-skill-path").value = file;
    } catch (err) {
      toast(err.message, "error", 8000);
    }
  });
  $("btn-add-skill").addEventListener("click", () => {
    const skillPath = $("f-skill-path").value.trim();
    if (!skillPath) return toast("请选择或输入 SKILL.md 的绝对路径", "error");
    const row = registeredSkillRow({
      name: $("f-skill-name").value.trim(),
      path: skillPath,
      enabled: true,
      description: "尚未验证；保存时将读取 SKILL.md。",
      error: "",
    });
    const empty = $("registered-skills-list").querySelector(".empty");
    if (empty) empty.remove();
    $("registered-skills-list").appendChild(row);
    $("f-skill-name").value = "";
    $("f-skill-path").value = "";
  });
  $("btn-reset-profiles").addEventListener("click", async () => {
    if (!confirm("只重置 Skill/插件 profile；已安装 Skill 目录和 Tunnel 配置不变。继续？")) return;
    try {
      const result = await call("resetProfiles");
      state.skills = result.catalog;
      state.registrations = [];
      renderSkillCatalog();
      toast("Skill/插件配置已重置为默认。", "success", 5000);
    } catch (err) {
      toast(err.message, "error", 9000);
    }
  });
  $("btn-uninstall-app").addEventListener("click", async () => {
    try {
      const result = await call("uninstallApp");
      if (!result.canceled) toast("数据已清理；现在可以删除 EXE 文件。", "success", 8000);
    } catch (err) {
      toast(err.message, "error", 9000);
    }
  });

  $("btn-start-all").addEventListener("click", () => action("startAll", "启动"));
  $("btn-stop-all").addEventListener("click", () => action("stopAll", "停止"));
  $("btn-stop-external").addEventListener("click", () => {
    if (confirm("将终止由旧脚本/手动启动的 MCP 与 Tunnel 进程（仅终止已识别为本项目的进程）。之后可用“启动全部”由本启动器接管。继续？")) {
      action("stopExternal", "接管");
    }
  });
  $("btn-mcp-start").addEventListener("click", () => action("startMcp"));
  $("btn-mcp-stop").addEventListener("click", () => action("stopMcp"));
  $("btn-mcp-restart").addEventListener("click", () => action("restartMcp", "MCP 重启"));
  $("f-tunnel-proxy-mode").addEventListener("change", () => {
    $("f-tunnel-proxy-url").disabled = $("f-tunnel-proxy-mode").value !== "custom";
  });
  $("btn-tunnel-start").addEventListener("click", () => action("startTunnel"));
  $("btn-tunnel-stop").addEventListener("click", () => action("stopTunnel"));

  $("link-health").addEventListener("click", () => call("openExternal", { url: url("http://127.0.0.1:{mcp}/health") }));
  $("link-admin").addEventListener("click", () => call("openExternal", { url: url("http://127.0.0.1:{admin}/ui") }));
  $("link-readyz").addEventListener("click", () => call("openExternal", { url: url("http://127.0.0.1:{tunnel}/readyz") }));
  $("link-tunnel-ui").addEventListener("click", () => call("openExternal", { url: url("http://127.0.0.1:{tunnel}/ui") }));
  $("btn-open-logs").addEventListener("click", () => call("openLogsFolder"));
  $("btn-open-runtime").addEventListener("click", () => call("openRuntimeFolder"));

  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => renderLog(b.dataset.log)));
  $("btn-open-log-file").addEventListener("click", async () => {
    try {
      await call("openLogFile", { name: state.activeLog });
    } catch (err) {
      toast(err.message, "error", 7000);
    }
  });
  $("btn-clear-log").addEventListener("click", async () => {
    await call("clearLogs", { name: state.activeLog });
    state.logs[state.activeLog] = [];
    renderLog(state.activeLog);
  });

  launcher.on("status", (s) => {
    if (!s || !state.accountId || s.accountId !== state.accountId) return;
    renderStatus(s);
  });
  launcher.on("log", (batch) => {
    const grouped = {};
    for (const entry of batch) {
      if (entry.accountId && entry.accountId !== state.accountId) continue;
      (grouped[entry.name] ||= []).push(entry.line);
    }
    for (const [name, lines] of Object.entries(grouped)) appendLogLines(name, lines);
  });
  launcher.on("notice", (n) => {
    if (n?.accountId && n.accountId !== state.accountId) return;
    toast(n.message, n.level === "error" ? "error" : "info", 8000);
  });
  launcher.on("setup:progress", (p) => {
    if (p?.accountId && p.accountId !== state.accountId) return;
    if (p.stage === "download") {
      const pct = p.total ? Math.round((p.received / p.total) * 100) : null;
      $("setup-progress-title").textContent = pct == null ? `下载 tunnel-client… ${Math.round(p.received / 1048576)} MB` : `下载 tunnel-client… ${pct}%`;
      $("setup-progress").hidden = false;
    } else if (p.stage === "doctor-line") {
      setupProgress(null, p.message);
    } else if (p.message) {
      setupProgress(p.message, `» ${p.message}`);
    }
  });
  launcher.on("accounts:changed", (snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.accounts)) return;
    state.accounts = snapshot;
    renderAccounts();
  });
}

async function init() {
  bind();
  try {
    state.accounts = await call("listAccounts");
    state.accountId = state.accounts.selectedId;
    renderAccounts();
    await reloadCurrentAccount({ navigate: true });
    $("page-subtitle").textContent = `${appIdentity()} · ${state.info.isPackaged ? "已打包" : "开发模式"}`;
    if (!state.info.encryptionAvailable) toast("警告：safeStorage 不可用，无法安全保存 Runtime API Key。", "error", 12000);
  } catch (err) {
    toast(`初始化界面失败: ${err.message}`, "error", 12000);
    showView("settings");
    showSettingsTab("setup");
  }
}

init();
