"use strict";
// One process pair per account. The registry contains labels/IDs only, never keys.
// Operational isolation is not a security sandbox for an untrusted Windows user.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const context = require("./account-context");
const MAX_ACCOUNTS = 16;
const PORT_KEYS = ["mcpPort", "adminPort", "tunnelPort"];
const START_METHODS = new Set(["startMcp", "startTunnel", "startAll", "restartMcp"]);

function checkedName(value) {
  if (typeof value !== "string") throw new Error("请填写账号名称。");
  const name = value.trim();
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new Error("账号名称须为 1–60 个可见字符，不得包含控制字符。");
  }
  return name;
}
function canonicalDirectory(value) {
  if (!path.isAbsolute(value)) throw new Error("工作区必须是绝对路径。");
  let cursor = path.resolve(value);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cursor);
      if (!fs.statSync(real).isDirectory()) throw new Error("工作区或其上级不是目录。");
      const resolved = path.resolve(real, ...tail);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function overlaps(a, b) {
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  return inside(a, b) || inside(b, a);
}
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
function atomicRegistry(file, text) {
  context.assertUnlinked(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = `${file}.${suffix}.tmp`;
  const backup = `${file}.${suffix}.bak`;
  let backedUp = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, file); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code) || !fs.existsSync(file)) throw error;
      fs.renameSync(file, backup);
      backedUp = true;
      try { fs.renameSync(temporary, file); }
      catch (publishError) {
        try { fs.renameSync(backup, file); backedUp = false; }
        catch (restoreError) { throw new Error(`账号索引写入失败；旧文件保留于 ${backup}: ${restoreError.message}`); }
        throw publishError;
      }
    }
    if (backedUp) { try { fs.unlinkSync(backup); } catch { /* keep a recoverable backup */ } }
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") { /* retain for diagnostics */ } } }
}

class AccountManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.app = options.app || require("electron").app;
    this.config = options.config || require("./config");
    this.paths = options.paths || require("./paths");
    this.makeServices = options.makeServices || (() => new (require("./services").Services)());
    this.makeFeeds = options.makeFeeds || (() => new (require("./feeds").ActivityFeeds)());
    this.portFree = options.portFree || isPortFree;
    this.registry = null;
    this.registryText = null;
    this.instances = new Map();
    this.mutations = Promise.resolve();
    this.shuttingDown = false;
    this.refreshPromise = null;
    this.services = this.facade("services");
    this.feeds = this.facade("feeds");
  }
  root() { return context.assertUnlinked(this.app.getPath("userData")); }
  registryFile() { return context.assertUnlinked(path.join(this.root(), "accounts.json")); }
  readRegistryText() {
    try { return fs.readFileSync(this.registryFile(), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  init() {
    if (this.registry) return this;
    const text = this.readRegistryText();
    let registry;
    try {
      registry = text === null ? {
        version: 1, revision: 0, selectedId: "default",
        accounts: [{ id: "default", name: "默认账号（原配置）", createdAt: null }],
      } : JSON.parse(text);
      if (!registry || registry.version !== 1 || !Array.isArray(registry.accounts) ||
          !registry.accounts.length || registry.accounts.length > MAX_ACCOUNTS) throw new Error("不支持的索引格式");
      const ids = new Set(); const names = new Set();
      for (const row of registry.accounts) {
        if (!row || !context.ID_RE.test(row.id) || ids.has(row.id)) throw new Error("账号 ID 无效或重复");
        const name = checkedName(row.name);
        if (name !== row.name || names.has(name.toLowerCase())) throw new Error("账号名称无效或重复");
        ids.add(row.id); names.add(name.toLowerCase());
      }
      if (!ids.has("default") || !ids.has(registry.selectedId)) throw new Error("默认或当前账号缺失");
      if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) throw new Error("索引版本无效");
    } catch (error) {
      throw new Error(`账号索引读取失败，未重置任何配置。请修复 ${this.registryFile()}: ${error.message}`);
    }
    this.registry = registry;
    this.registryText = text;
    return this;
  }
  get selectedId() { this.init(); return this.registry.selectedId; }
  get currentId() { return context.current()?.id || this.selectedId; }
  record(id) {
    this.init();
    const row = this.registry.accounts.find((item) => item.id === id);
    if (!row) throw new Error("该账号不存在或已移除，请刷新账号列表。");
    return row;
  }
  makeScope(id) {
    if (!context.ID_RE.test(id)) throw new Error("无效的账号 ID。");
    const root = this.root();
    const dataDir = context.assertUnlinked(id === "default" ? root : path.join(root, "accounts", id));
    return Object.freeze({ id, dataDir });
  }
  scope(id = this.currentId) { this.record(id); return this.makeScope(id); }
  run(id, fn) { return context.run(this.scope(id), fn); }
  readConfig(id = this.currentId) {
    return this.run(id, () => {
      if (id !== "default" && !fs.existsSync(this.paths.configPath())) {
        throw new Error(`账号「${this.record(id).name}」配置缺失，已阻止使用默认端口代替。`);
      }
      return this.config.load();
    });
  }
  publish(next) {
    if (this.readRegistryText() !== this.registryText) throw new Error("账号索引被其他程序修改；未覆盖。请关闭并重新打开此程序后重试。");
    const value = { ...next, version: 1, revision: this.registry.revision + 1 };
    const text = JSON.stringify(value, null, 2) + "\n";
    atomicRegistry(this.registryFile(), text);
    this.registry = value;
    this.registryText = text;
    this.emit("accounts-changed");
  }
  enqueue(fn) {
    const result = this.mutations.then(() => {
      if (this.shuttingDown) throw new Error("程序正在退出，不能再修改账号。");
      this.init();
      return fn();
    });
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
  async allocatePorts() {
    const used = new Set(this.registry.accounts.flatMap((row) => {
      const cfg = this.readConfig(row.id);
      return PORT_KEYS.map((key) => cfg[key]);
    }));
    // Bounded probing; never seize or kill an existing listener.
    for (let base = 3400; base < 4400; base += 10) {
      const ports = [base, base + 1, base + 2];
      if (ports.some((port) => used.has(port))) continue;
      if ((await Promise.all(ports.map((port) => this.portFree(port)))).every(Boolean)) {
        return Object.fromEntries(PORT_KEYS.map((key, index) => [key, ports[index]]));
      }
    }
    throw new Error("未找到三组可用端口；没有终止任何现有服务。");
  }
  validateConfig(id, cfg) {
    const ownPorts = PORT_KEYS.map((key) => cfg[key]);
    if (ownPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ownPorts).size !== 3) {
      throw new Error("MCP、Admin、Tunnel 必须使用三个不同的有效端口。");
    }
    if (cfg.tunnelId && !this.config.validateTunnelId(cfg.tunnelId)) throw new Error("Tunnel ID 格式不正确。");
    const ownWorkspace = cfg.workspacePath ? canonicalDirectory(cfg.workspacePath) : null;
    for (const other of this.registry.accounts) {
      if (other.id === id) continue;
      const saved = this.readConfig(other.id);
      if (PORT_KEYS.some((key) => ownPorts.includes(saved[key]))) throw new Error(`端口与账号「${other.name}」重复，请使用独立端口。`);
      if (cfg.tunnelId && cfg.tunnelId === saved.tunnelId) throw new Error(`Tunnel ID 已属于账号「${other.name}」，请为此账号创建独立隧道。`);
      if (ownWorkspace && saved.workspacePath && overlaps(ownWorkspace, canonicalDirectory(saved.workspacePath))) {
        throw new Error(`工作区与账号「${other.name}」相同或互相包含，请选择互不重叠的目录。`);
      }
    }
    if (ownWorkspace && overlaps(ownWorkspace, canonicalDirectory(this.root()))) {
      throw new Error("工作区不能包含应用账号数据目录，也不能位于其中；请选择独立的项目目录。");
    }
    return cfg;
  }
  assertStopped(id = this.currentId) {
    const item = this.instances.get(id);
    if (item && (item.services.busy || item.services.mcp.isAlive() || item.services.tunnel.isAlive())) {
      throw new Error(`请先停止账号「${this.record(id).name}」的 MCP 和隧道，再修改设置；其他账号无需停止。`);
    }
  }
  create(payload = {}) {
    return this.enqueue(async () => {
      const name = checkedName(payload.name);
      if (this.registry.accounts.length >= MAX_ACCOUNTS) throw new Error(`最多保留 ${MAX_ACCOUNTS} 个账号配置档。`);
      if (this.registry.accounts.some((row) => row.name.toLowerCase() === name.toLowerCase())) throw new Error("账号名称已存在。");
      const id = crypto.randomUUID().replace(/-/g, "");
      const scope = this.makeScope(id);
      const ports = await this.allocatePorts();
      const workspacePath = typeof payload.workspacePath === "string" && payload.workspacePath.trim()
        ? payload.workspacePath.trim() : path.join(this.app.getPath("documents"), "Web Harness Workspaces", id);
      if (this.shuttingDown) throw new Error("程序正在退出，已取消账号创建。");
      const cfg = { ...this.config.DEFAULTS, ...ports, workspacePath, setupDone: false, autoStart: false, tunnelId: "", apiKeyEnc: "" };
      this.validateConfig(id, cfg);
      context.run(scope, () => {
        fs.mkdirSync(scope.dataDir, { recursive: true });
        this.config.save(cfg);
        this.paths.ensureRuntimeDir();
      });
      this.publish({ ...this.registry, accounts: [...this.registry.accounts, { id, name, createdAt: new Date().toISOString() }] });
      return { id, name, config: this.config.publicView(cfg), dataDir: scope.dataDir };
    });
  }
  select(id) {
    return this.enqueue(() => {
      this.record(id);
      this.readConfig(id); // fail closed before changing the selection
      if (id !== this.registry.selectedId) this.publish({ ...this.registry, selectedId: id });
      this.emit("selected", { id });
      return this.list();
    });
  }
  rename(id, value) {
    return this.enqueue(() => {
      this.record(id);
      const name = checkedName(value);
      if (this.registry.accounts.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) throw new Error("账号名称已存在。");
      this.publish({ ...this.registry, accounts: this.registry.accounts.map((row) => row.id === id ? { ...row, name } : row) });
      return this.list();
    });
  }
  list() {
    this.init();
    return {
      selectedId: this.selectedId, maxAccounts: MAX_ACCOUNTS, registryPath: this.registryFile(),
      securityBoundary: "运行配置档隔离；不是 Windows 用户或系统安全沙箱",
      accounts: this.registry.accounts.map((row) => {
        const cfg = this.readConfig(row.id);
        const item = this.instances.get(row.id);
        return { ...row, config: this.config.publicView(cfg), dataDir: this.scope(row.id).dataDir,
          mcp: { state: item?.services.mcp.state || "stopped", pid: item?.services.mcp.pid || null, owned: Boolean(item?.services.mcp.isAlive()) },
          tunnel: { state: item?.services.tunnel.state || "stopped", pid: item?.services.tunnel.pid || null, owned: Boolean(item?.services.tunnel.isAlive()), cloudState: item?.snapshot?.tunnel?.cloudState || "unknown" },
          busy: Boolean(item?.services.busy), lastError: item?.lastError || "" };
      }),
    };
  }
  instance(id = this.currentId) {
    if (this.instances.has(id)) return this.instances.get(id);
    const scope = this.scope(id);
    return context.run(scope, () => {
      const service = this.makeServices();
      const feed = this.makeFeeds();
      const item = { services: service, feeds: feed, snapshot: null, scope, lastError: "" };
      this.instances.set(id, item);
      // Guard nested start calls as well, including startAll continuing during quit.
      for (const name of START_METHODS) {
        if (typeof service[name] !== "function") continue;
        const original = service[name].bind(service);
        service[name] = context.bind(scope, (...args) => {
          if (this.shuttingDown) throw new Error("程序正在退出，已取消后续启动。");
          this.validateConfig(id, this.readConfig(id));
          return original(...args);
        });
      }
      service.on("log", context.bind(scope, (entry) => this.emit("log", { ...entry, accountId: id })));
      service.on("status", context.bind(scope, (snapshot) => {
        item.snapshot = { ...snapshot, accountId: id, accountName: this.record(id).name };
        this.syncFeed(item);
        if (id === this.selectedId) this.emit("status", item.snapshot);
        this.emit("accounts-changed");
      }));
      feed.on("lines", context.bind(scope, (entry) => this.emit("feed-lines", { ...entry, accountId: id })));
      return item;
    });
  }
  syncFeed(item) {
    if (this.shuttingDown || (!item.services.mcp.isAlive() && !item.services.tunnel.isAlive())) { item.feeds.stop(); return; }
    try {
      const cfg = this.readConfig(item.scope.id);
      const adminToken = this.config.getAdminToken(cfg);
      item.feeds.configure({ adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, adminToken });
      item.feeds.start();
      item.lastError = "";
    } catch (error) {
      item.feeds.stop();
      item.lastError = error.message;
    }
  }
  facade(kind) {
    const manager = this;
    const emitter = kind === "services" ? { log: "log", status: "status" } : { lines: "feed-lines" };
    const proxy = new Proxy({}, {
      get(_target, key) {
        if (key === "on") return (event, handler) => { manager.on(emitter[event] || event, handler); return proxy; };
        if (kind === "services" && key === "shutdown") return () => manager.shutdownAll();
        if (kind === "feeds" && key === "stop") return () => manager.stopFeeds();
        const id = manager.currentId;
        const scope = manager.scope(id);
        return context.run(scope, () => {
          const target = manager.instance(id)[kind];
          const value = target[key];
          if (typeof value === "function") return context.bind(scope, (...args) => value.apply(target, args));
          if (kind === "services" && ["mcp", "tunnel"].includes(key)) {
            return new Proxy(value, { get(object, property) {
              return context.run(scope, () => typeof object[property] === "function" ? context.bind(scope, object[property].bind(object)) : object[property]);
            } });
          }
          return value;
        });
      },
    });
    return proxy;
  }
  async refreshAll() {
    if (this.shuttingDown) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.instance(this.selectedId);
    this.refreshPromise = Promise.all([...this.instances].filter(([id, item]) => id === this.selectedId || item.services.busy || item.services.mcp.isAlive() || item.services.tunnel.isAlive())
      .map(([id, item]) => this.run(id, async () => {
        try { await item.services.refresh(); }
        catch (error) { item.lastError = error.message; }
      }))).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async autoStart() {
    for (const row of this.registry.accounts) {
      if (this.shuttingDown) return;
      try {
        const cfg = this.readConfig(row.id);
        if (!cfg.setupDone || !cfg.autoStart) continue;
        await this.run(row.id, () => this.instance(row.id).services.startAll());
      } catch (error) { this.emit("account-error", { accountId: row.id, message: error.message }); }
    }
  }
  anyAlive() { return [...this.instances.values()].some((item) => item.services.mcp.isAlive() || item.services.tunnel.isAlive() || item.services.busy); }
  stopFeeds() { for (const [id, item] of this.instances) this.run(id, () => item.feeds.stop()); }
  async shutdownAll() {
    this.shuttingDown = true;
    this.stopFeeds();
    await Promise.all([...this.instances].map(([id, item]) => this.run(id, () => item.services.shutdown())));
  }
}
module.exports = { AccountManager, MAX_ACCOUNTS, PORT_KEYS, checkedName, canonicalDirectory, overlaps, isPortFree };
