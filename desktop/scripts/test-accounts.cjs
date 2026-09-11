"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const src = path.resolve(__dirname, "../src");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-account-test-"));
  const root = path.join(temp, "userData");
  const docs = path.join(temp, "documents");
  fs.mkdirSync(root); fs.mkdirSync(docs);
  const app = { isPackaged: false, getPath: (name) => name === "documents" ? docs : root, getVersion: () => "test" };
  const electron = { app, safeStorage: {
    isEncryptionAvailable: () => true,
    // Deliberate unit-test fixture, never production encryption or credentials.
    encryptString: (value) => Buffer.from(`test-only:${value}`),
    decryptString: (value) => value.toString().replace(/^test-only:/, ""),
  } };
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const real = createRequire(filename);
    const requireHere = (name) => name === "electron" ? electron
      : name.startsWith("./") && !name.endsWith(".json") ? load(real.resolve(name)) : real(name);
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, exports: module.exports, require: requireHere, __filename: filename, __dirname: path.dirname(filename),
      process, Buffer, console, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    }, { filename });
    return module.exports;
  }
  const context = load(path.join(src, "account-context.js"));
  const paths = load(path.join(src, "paths.js"));
  const config = load(path.join(src, "config.js"));
  const { AccountManager } = load(path.join(src, "accounts.js"));
  let pid = 100;
  class FakeService extends EventEmitter {
    constructor() {
      super(); this.busy = false; this.launcherLines = [];
      this.mcp = { state: "stopped", pid: null, lines: [], isAlive() { return this.state === "running"; } };
      this.tunnel = { state: "stopped", pid: null, lines: [], isAlive() { return this.state === "running"; } };
    }
    note(line) { this.launcherLines.push(line); this.emit("log", { name: "launcher", line }); }
    async startMcp() {
      this.mcp.state = "running"; this.mcp.pid = ++pid;
      await delay(8);
      fs.mkdirSync(paths.logsDir(), { recursive: true });
      fs.appendFileSync(path.join(paths.logsDir(), "ownership.log"), `${context.current().id}\n`);
      this.note(context.current().id); return this.refresh();
    }
    async startTunnel() { this.tunnel.state = "running"; this.tunnel.pid = ++pid; return this.refresh(); }
    async startAll() { await this.startMcp(); await this.startTunnel(); }
    async stopMcp() { this.mcp.state = "stopped"; this.mcp.pid = null; return this.refresh(); }
    async stopTunnel() { this.tunnel.state = "stopped"; this.tunnel.pid = null; return this.refresh(); }
    async stopAll() { await this.stopTunnel(); await this.stopMcp(); }
    async restartMcp() { await this.stopMcp(); await this.startMcp(); }
    async refresh() { const snapshot = { config: config.publicView(config.load()), mcp: { state: this.mcp.state }, tunnel: { state: this.tunnel.state } }; this.emit("status", snapshot); return snapshot; }
    async shutdown() { await this.stopAll(); }
  }
  class FakeFeeds extends EventEmitter {
    configure(value) { this.value = value; }
    start() { this.running = true; }
    stop() { this.running = false; }
  }
  const manager = new AccountManager({ app, config, paths, makeServices: () => new FakeService(), makeFeeds: () => new FakeFeeds(), portFree: async () => true });
  manager.init();
  t.after(async () => { await manager.shutdownAll(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { manager, context, paths, config, root, docs, temp, app, load, AccountManager };
}

test("default account migration does not rewrite legacy config or create a registry", (t) => {
  const f = fixture(t);
  const legacy = '{ "setupDone": false, "apiKeyEnc": "existing-ciphertext", "mcpPort": 3300 }\n';
  fs.writeFileSync(path.join(f.root, "config.json"), legacy);
  assert.equal(f.manager.selectedId, "default");
  assert.equal(f.manager.run("default", () => f.paths.configPath()), path.join(f.root, "config.json"));
  assert.equal(f.manager.list().accounts[0].config.hasApiKey, true);
  assert.equal(fs.readFileSync(path.join(f.root, "config.json"), "utf8"), legacy);
  assert.equal(fs.existsSync(path.join(f.root, "accounts.json")), false);
});

test("new accounts receive unique names, ports and private data roots, not copied keys", async (t) => {
  const f = fixture(t);
  f.manager.run("default", () => f.config.save({ ...f.config.DEFAULTS, apiKeyEnc: "old-ciphertext", adminTokenEnc: "old-admin", autoStart: true }));
  const a = await f.manager.create({ name: "个人账号 A" });
  const b = await f.manager.create({ name: "Business B" });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.config.mcpPort, b.config.mcpPort);
  assert.notEqual(a.dataDir, b.dataDir);
  const cfg = f.manager.readConfig(b.id);
  assert.equal(cfg.apiKeyEnc, ""); assert.equal(cfg.adminTokenEnc, undefined);
  assert.equal(cfg.setupDone, false); assert.equal(cfg.autoStart, false);
  assert.equal(f.manager.selectedId, "default");
  assert.equal(fs.existsSync(path.join(b.dataDir, "runtime/profiles/plugins.json")), true);
  assert.equal(JSON.stringify(f.manager.list()).includes("old-ciphertext"), false);
});

test("concurrent profile creation is serialized and a failed mutation does not poison the queue", async (t) => {
  const f = fixture(t);
  const result = await Promise.allSettled([f.manager.create({ name: "same" }), f.manager.create({ name: "same" })]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
  await f.manager.create({ name: "after-error" });
  assert.equal(f.manager.list().accounts.length, 3);
});

test("configuration rejects cross-account ports, tunnel identity and overlapping workspaces", async (t) => {
  const f = fixture(t);
  const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  const first = f.manager.readConfig(a.id); const second = f.manager.readConfig(b.id);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, adminPort: first.mcpPort }), /端口/);
  first.tunnelId = `tunnel_${"a".repeat(32)}`;
  f.manager.run(a.id, () => f.config.save(first));
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, tunnelId: first.tunnelId }), /Tunnel ID/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, workspacePath: path.join(first.workspacePath, "nested") }), /工作区/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, workspacePath: f.root }), /工作区/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, tunnelPort: NaN }), /端口/);
});

test("occupied port candidates are skipped without touching the listener", async (t) => {
  const f = fixture(t); const probed = [];
  f.manager.portFree = async (port) => { probed.push(port); return port >= 3410; };
  const a = await f.manager.create({ name: "skip occupied" });
  assert.equal(a.config.mcpPort, 3410);
  assert.ok(probed.includes(3400));
});

test("registry corruption fails closed with original bytes retained", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "accounts.json");
  for (const text of ["{bad", "null", JSON.stringify({ version: 2, accounts: [] })]) {
    fs.writeFileSync(file, text);
    const manager = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths });
    assert.throws(() => manager.init(), /未重置/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
});

test("external registry edits fail CAS instead of being overwritten", async (t) => {
  const f = fixture(t); await f.manager.create({ name: "A" });
  const file = path.join(f.root, "accounts.json"); const external = fs.readFileSync(file, "utf8") + "\n";
  fs.writeFileSync(file, external);
  await assert.rejects(f.manager.rename("default", "renamed"), /其他程序/);
  assert.equal(fs.readFileSync(file, "utf8"), external);
});

test("missing account configuration cannot fall back to another account's default ports", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  fs.unlinkSync(path.join(a.dataDir, "config.json"));
  await assert.rejects(f.manager.select(a.id), /配置缺失/);
  assert.equal(f.manager.selectedId, "default");
});

test("IDs cannot traverse paths and names cannot spoof account identities with bidi controls", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.manager.makeScope("../../elsewhere"), /ID/);
  await assert.rejects(f.manager.create({ name: "A\u202eB" }), /控制字符/);
  await assert.rejects(f.manager.select("f".repeat(32)), /不存在/);
});

test("account data junction is rejected, without accessing or deleting its target", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  const moved = `${a.dataDir}-saved`;
  fs.renameSync(a.dataDir, moved);
  fs.symlinkSync(moved, a.dataDir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.manager.readConfig(a.id), /junction/);
  fs.unlinkSync(a.dataDir);
  assert.equal(fs.existsSync(path.join(moved, "config.json")), true);
});

test("workspace junction overlap is detected by canonical path, not text prefix", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  fs.mkdirSync(a.config.workspacePath, { recursive: true });
  const alias = path.join(f.docs, "alias-a");
  fs.symlinkSync(a.config.workspacePath, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.manager.validateConfig(b.id, { ...f.manager.readConfig(b.id), workspacePath: alias }), /工作区/);
  fs.unlinkSync(alias);
});

test("in-flight service operation, delayed logs and configuration remain bound after UI selection changes", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  const events = []; f.manager.on("log", (entry) => events.push(entry));
  const delayedStart = f.manager.run(a.id, () => f.manager.services.startMcp());
  await f.manager.select(b.id);
  await f.manager.services.startMcp(); await delayedStart;
  assert.equal(fs.readFileSync(path.join(a.dataDir, "logs/ownership.log"), "utf8").trim(), a.id);
  assert.equal(fs.readFileSync(path.join(b.dataDir, "logs/ownership.log"), "utf8").trim(), b.id);
  assert.ok(events.some((e) => e.accountId === a.id && e.line === a.id));
  assert.ok(events.some((e) => e.accountId === b.id && e.line === b.id));
  assert.notEqual(f.manager.instance(a.id).services.mcp.pid, f.manager.instance(b.id).services.mcp.pid);
});

test("stopping one account preserves the other account's services and buffered logs", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  await f.manager.run(a.id, () => f.manager.services.startAll());
  await f.manager.run(b.id, () => f.manager.services.startAll());
  await f.manager.run(a.id, () => f.manager.services.stopAll());
  assert.equal(f.manager.instance(a.id).services.mcp.isAlive(), false);
  assert.equal(f.manager.instance(b.id).services.mcp.isAlive(), true);
  assert.equal(f.manager.instance(b.id).services.tunnel.isAlive(), true);
  assert.throws(() => f.manager.assertStopped(b.id), /先停止/);
  assert.doesNotThrow(() => f.manager.assertStopped(a.id));
});

test("application shutdown stops all owned accounts and prevents subsequent starts", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  await f.manager.run(a.id, () => f.manager.services.startAll());
  await f.manager.run(b.id, () => f.manager.services.startAll());
  await f.manager.shutdownAll();
  assert.equal(f.manager.anyAlive(), false);
  assert.throws(() => f.manager.run(b.id, () => f.manager.services.startMcp()), /退出/);
});

test("select and rename survive reload without moving existing config", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  await f.manager.rename(a.id, "账号 A（工作）"); await f.manager.select(a.id);
  const second = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths });
  second.init();
  assert.equal(second.selectedId, a.id);
  assert.equal(second.record(a.id).name, "账号 A（工作）");
  assert.equal(second.scope(a.id).dataDir, a.dataDir);
});
