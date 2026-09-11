"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-computer-use-account-"));
  const userData = path.join(tmp, "user-data");
  const hostHome = path.join(tmp, "host-user");
  const versionRoot = path.join(hostHome, ".codex", "plugins", "cache", "openai-bundled", "computer-use", "99.0.0");
  const skillPath = path.join(versionRoot, "skills", "computer-use", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, "# fixture Computer Use\n", "utf8");
  fs.mkdirSync(userData, { recursive: true });

  const previousEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.USERPROFILE = hostHome;
  process.env.HOME = hostHome;
  process.env.CODEX_HOME = path.join(tmp, "must-not-own-computer-use");

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "electron") {
      return { app: { isPackaged: false, getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const accountContext = require("../src/account-context");
    const skills = require("../src/skills");
    Module._load = originalLoad;

    const a = { id: "a".repeat(32), dataDir: path.join(tmp, "account-a") };
    const b = { id: "b".repeat(32), dataDir: path.join(tmp, "account-b") };
    const workspace = path.join(tmp, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    await accountContext.run(a, async () => {
      assert.equal((await skills.setComputerUseEnabled(true)).enabled, true);
      const catalog = await skills.catalog(workspace);
      assert.equal(catalog.computerUse.available, true);
      assert.equal(catalog.computerUse.enabled, true);
      assert.equal(path.resolve(catalog.computerUse.path), path.resolve(skillPath));
      assert.ok(catalog.configPath.startsWith(path.join(a.dataDir, "runtime")));
    });
    await accountContext.run(b, async () => {
      assert.equal((await skills.setComputerUseEnabled(false)).enabled, false);
      const catalog = await skills.catalog(workspace);
      assert.equal(catalog.computerUse.available, true, "host bundle must remain discoverable for another isolated account");
      assert.equal(catalog.computerUse.enabled, false);
      assert.ok(catalog.configPath.startsWith(path.join(b.dataDir, "runtime")));
    });

    const configA = path.join(a.dataDir, "runtime", "profiles", "plugins.json");
    const configB = path.join(b.dataDir, "runtime", "profiles", "plugins.json");
    assert.equal(JSON.parse(fs.readFileSync(configA, "utf8")).computer_use.enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).computer_use.enabled, false);
    assert.notEqual(path.resolve(configA), path.resolve(configB));

    await accountContext.run(a, async () => {
      assert.equal((await skills.setComputerUseEnabled(false)).enabled, false);
      assert.equal((await skills.catalog(workspace)).computerUse.enabled, false);
      assert.equal((await skills.setComputerUseEnabled(true)).enabled, true);
      assert.equal((await skills.catalog(workspace)).computerUse.enabled, true);
    });
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).computer_use.enabled, false, "account A toggle must not modify account B");
    console.log("COMPUTER_USE_ACCOUNT_ISOLATION_PASS");
  } finally {
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
