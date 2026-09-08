/** Environment for commands launched through MCP tools.
 *
 * The harness intentionally grants broad filesystem access, but transport and
 * Admin bearer tokens must not be inherited by arbitrary Skill commands.
 */
export function childProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ADMIN_TOKEN;
  delete env.MCP_TOKEN;
  delete env.MCP_API_KEY;
  delete env.RUNTIME_API_KEY;
  delete env.OPENAI_TUNNEL_API_KEY;
  delete env.CONTROL_PLANE_API_KEY;
  return { ...env, ...overrides };
}
