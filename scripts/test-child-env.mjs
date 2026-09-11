import assert from "node:assert/strict";

const previous = {};
for (const key of ["ADMIN_TOKEN", "MCP_TOKEN", "MCP_API_KEY", "RUNTIME_API_KEY", "OPENAI_TUNNEL_API_KEY", "CONTROL_PLANE_API_KEY", "HARNESS_COMPUTER_USE_CODEX_HOME", "HARNESS_COMPUTER_USE_RUNTIME_ROOT"]) {
  previous[key] = process.env[key];
  process.env[key] = `fixture-${key.toLowerCase()}`;
}
try {
  const { childProcessEnv } = await import("../dist/lib/child-env.js");
  const env = childProcessEnv();
  for (const key of ["ADMIN_TOKEN", "MCP_TOKEN", "MCP_API_KEY", "RUNTIME_API_KEY", "OPENAI_TUNNEL_API_KEY", "CONTROL_PLANE_API_KEY", "HARNESS_COMPUTER_USE_CODEX_HOME", "HARNESS_COMPUTER_USE_RUNTIME_ROOT"]) {
    assert.equal(key in env, false, `arbitrary child env leaked ${key}`);
  }
  console.log("child-env: Admin/MCP/Tunnel credentials and host Computer Use discovery hints stripped from arbitrary Skill command environment OK");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
