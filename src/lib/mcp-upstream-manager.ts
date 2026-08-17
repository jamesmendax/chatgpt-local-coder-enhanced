import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  loadUpstreamConfig,
  saveUpstreamConfig,
  type UpstreamConfigFile,
  type UpstreamServerConfig,
  resolveUpstreamConfigPath,
} from "./mcp-upstream-config.js";
import { FileOAuthClientProvider } from "./mcp-oauth-provider.js";

export type UpstreamHealth = "unknown" | "connected" | "reachable" | "unreachable" | "disabled";

export interface UpstreamServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  auth: string;
  health: UpstreamHealth;
  connected: boolean;
  tool_count: number;
  expose: string;
  proxied_tools: string[];
  last_error?: string;
  pid?: number | null;
}

interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Tool[];
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastError?: string;
  connected: boolean;
}

let singleton: McpUpstreamManager | null = null;

export class McpUpstreamManager {
  private config: UpstreamConfigFile;
  private configPath: string;
  private connections = new Map<string, UpstreamConnection>();
  private connecting = new Map<string, Promise<UpstreamConnection>>();
  private servers = new Set<McpServer>();
  private toolsCache = new Map<string, { tools: Tool[]; expiresAt: number }>();
  private oauthProviders = new Map<string, FileOAuthClientProvider>();
  private readonly toolsCacheTtlMs = 60_000;
  private readonly connectTimeoutMs = Math.max(1_000, Number(process.env.MCP_UPSTREAM_CONNECT_TIMEOUT_MS) || 15_000);

  constructor(configPath = resolveUpstreamConfigPath()) {
    this.configPath = configPath;
    this.config = { version: 1, servers: [] };
  }

  async init(): Promise<void> {
    this.config = await loadUpstreamConfig(this.configPath);
  }

  registerMcpServer(server: McpServer): void {
    this.servers.add(server);
  }

  unregisterMcpServer(server: McpServer): void {
    this.servers.delete(server);
  }

  getConfig(): UpstreamConfigFile {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  listServerConfigs(): UpstreamServerConfig[] {
    return [...this.config.servers];
  }

  getServerConfig(serverId: string): UpstreamServerConfig | undefined {
    return this.config.servers.find((s) => s.id === serverId);
  }

  async reloadConfig(): Promise<UpstreamConfigFile> {
    await this.shutdown();
    this.config = await loadUpstreamConfig(this.configPath);
    this.oauthProviders.clear();
    await this.refreshAllProxies();
    return this.config;
  }

  async updateConfig(next: UpstreamConfigFile): Promise<UpstreamConfigFile> {
    await saveUpstreamConfig(next, this.configPath);
    await this.shutdown();
    this.config = next;
    this.oauthProviders.clear();
    await this.refreshAllProxies();
    return this.config;
  }

  async upsertServer(server: UpstreamServerConfig): Promise<void> {
    const idx = this.config.servers.findIndex((s) => s.id === server.id);
    if (idx >= 0) this.config.servers[idx] = server;
    else this.config.servers.push(server);
    await this.updateConfig(this.config);
  }

  async removeServer(serverId: string): Promise<boolean> {
    const before = this.config.servers.length;
    this.config.servers = this.config.servers.filter((s) => s.id !== serverId);
    if (this.config.servers.length === before) return false;
    await this.disconnect(serverId);
    await this.updateConfig(this.config);
    return true;
  }

  private async disconnectDisabled(): Promise<void> {
    const enabledIds = new Set(this.config.servers.filter((s) => s.enabled).map((s) => s.id));
    for (const id of [...this.connections.keys()]) {
      if (!enabledIds.has(id)) await this.disconnect(id);
    }
  }

  private getEnabledServers(): UpstreamServerConfig[] {
    return this.config.servers.filter((s) => s.enabled);
  }

  private scheduleIdleDisconnect(serverId: string, conn: UpstreamConnection): void {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    const timeoutSec = conn.config.idle_timeout_sec ?? 600;
    if (timeoutSec <= 0) return;
    conn.idleTimer = setTimeout(() => {
      void this.disconnect(serverId);
    }, timeoutSec * 1000);
  }

  private touch(conn: UpstreamConnection): void {
    conn.lastUsedAt = Date.now();
    this.scheduleIdleDisconnect(conn.config.id, conn);
  }

  private shouldUseOAuth(config: UpstreamServerConfig): boolean {
    if (config.transport !== "http") return false;
    const mode = config.auth?.type ?? "auto";
    if (mode === "none") return false;
    if (mode === "oauth") return true;
    const hasHeaders = Object.keys(config.headers ?? {}).length > 0;
    return !hasHeaders && !config.bearer_token_env_var;
  }

  private getOAuthProvider(config: UpstreamServerConfig): FileOAuthClientProvider {
    let provider = this.oauthProviders.get(config.id);
    if (!provider) {
      provider = new FileOAuthClientProvider({
        serverId: config.id,
        scope: config.auth?.scope,
        openBrowser: false,
      });
      this.oauthProviders.set(config.id, provider);
    }
    return provider;
  }

  async oauthStatus(serverId: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!this.shouldUseOAuth(config)) {
      return { configured: false, connected: false, pending: false, auth: config.auth?.type ?? "none" };
    }
    return { ...(await this.getOAuthProvider(config).authorizationStatus()), auth: config.auth?.type ?? "auto" };
  }

  async startOAuth(serverId: string, resetTokens = true) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    if (!this.shouldUseOAuth(config)) throw new Error(`OAuth is disabled or static auth is configured for ${serverId}`);

    await this.disconnect(serverId);
    const provider = this.getOAuthProvider(config);
    await provider.beginAuthorization({ resetTokens });
    const result = await auth(provider, { serverUrl: config.url, scope: config.auth?.scope });
    const status = await provider.authorizationStatus();
    return { ...status, result };
  }

  async finishOAuth(serverId: string, authorizationCode: string, state?: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    if (!(await provider.verifyState(state))) throw new Error("OAuth state mismatch or expired authorization flow");

    const result = await auth(provider, {
      serverUrl: config.url,
      authorizationCode,
      scope: config.auth?.scope,
    });
    if (result !== "AUTHORIZED") throw new Error(`OAuth authorization did not complete for ${serverId}`);
    await provider.completeAuthorization();
    await this.disconnect(serverId);
    return this.checkHealth(serverId);
  }

  async disconnectOAuth(serverId: string): Promise<void> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    await provider.invalidateCredentials("tokens");
    await provider.invalidateCredentials("verifier");
    await provider.completeAuthorization();
    await this.disconnect(serverId);
  }

  private async createTransport(config: UpstreamServerConfig): Promise<{
    client: Client;
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    pid: number | null;
  }> {
    const client = new Client({ name: "codex-mcp-hub", version: "2.0.0" });

    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: "pipe",
      });
      await this.connectClient(client, transport, config.id);
      return { client, transport, pid: transport.pid };
    }

    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    const bearerEnv = config.bearer_token_env_var?.trim();
    if (bearerEnv) {
      const token = process.env[bearerEnv]?.trim();
      if (!token) throw new Error(`Missing bearer token environment variable for ${config.id}: ${bearerEnv}`);
      if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      authProvider: this.shouldUseOAuth(config) ? this.getOAuthProvider(config) : undefined,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
    await this.connectClient(client, transport, config.id);
    return { client, transport, pid: null };
  }

  private async withConnectTimeout<T>(operation: Promise<T>, serverId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Upstream connection timed out after ${this.connectTimeoutMs}ms: ${serverId}`)),
            this.connectTimeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectClient(
    client: Client,
    transport: StdioClientTransport | StreamableHTTPClientTransport,
    serverId: string
  ): Promise<void> {
    try {
      await this.withConnectTimeout(client.connect(transport), serverId);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async connect(serverId: string, force = false): Promise<UpstreamConnection> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!config.enabled) throw new Error(`Upstream server disabled: ${serverId}`);

    const pending = this.connecting.get(serverId);
    if (pending) {
      const connection = await pending;
      if (!force) {
        this.touch(connection);
        return connection;
      }
    }

    const existing = this.connections.get(serverId);
    if (existing && existing.connected && !force) {
      this.touch(existing);
      return existing;
    }

    if (existing) await this.disconnect(serverId);

    const attempt = (async (): Promise<UpstreamConnection> => {
      const { client, transport, pid } = await this.withConnectTimeout(this.createTransport(config), serverId);
      try {
        const list = await this.withConnectTimeout(client.listTools(), serverId);
        const tools = list.tools ?? [];
        const conn: UpstreamConnection = {
          config,
          client,
          transport,
          tools,
          lastUsedAt: Date.now(),
          idleTimer: null,
          connected: true,
          lastError: undefined,
        };
        if (config.transport === "stdio" && pid) {
          (conn as UpstreamConnection & { pid?: number }).pid = pid;
        }

        this.connections.set(serverId, conn);
        this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
        this.touch(conn);
        return conn;
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
    })();
    this.connecting.set(serverId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.connecting.get(serverId) === attempt) this.connecting.delete(serverId);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    try {
      await conn.transport.close();
    } catch {}
    this.connections.delete(serverId);
    this.toolsCache.delete(serverId);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      await this.disconnect(id);
    }
  }

  async listTools(serverId: string): Promise<Tool[]> {
    const cached = this.toolsCache.get(serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    const conn = await this.connect(serverId);
    const list = await conn.client.listTools();
    const tools = list.tools ?? [];
    conn.tools = tools;
    this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
    return tools;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const conn = await this.connect(serverId);
    this.touch(conn);
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  async checkHealth(serverId: string): Promise<UpstreamServerStatus> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);

    if (!config.enabled) {
      return this.buildStatus(config, "disabled", false, []);
    }

    try {
      const conn = await this.connect(serverId);
      return this.buildStatus(config, "connected", true, conn.tools, undefined, conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.buildStatus(config, "unreachable", false, [], message);
    }
  }

  async listStatuses(): Promise<UpstreamServerStatus[]> {
    return Promise.all(this.config.servers.map((config) => this.checkHealth(config.id)));
  }

  private buildStatus(
    config: UpstreamServerConfig,
    health: UpstreamHealth,
    connected: boolean,
    tools: Tool[],
    lastError?: string,
    conn?: UpstreamConnection
  ): UpstreamServerStatus {
    const proxied = this.getProxiedToolNames(config, tools);
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: config.transport,
      auth: config.transport !== "http" ? "none" : this.shouldUseOAuth(config) ? "oauth" : (Object.keys(config.headers ?? {}).length || config.bearer_token_env_var) ? "static" : "none",
      health,
      connected,
      tool_count: tools.length,
      expose: config.expose,
      proxied_tools: proxied,
      last_error: lastError,
      pid: conn && "pid" in conn ? (conn as UpstreamConnection & { pid?: number }).pid ?? null : null,
    };
  }

  getProxiedToolNames(config: UpstreamServerConfig, tools: Tool[]): string[] {
    if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return [];
    const prefix = `${config.tool_prefix ?? config.id}__`;
    return tools
      .filter((tool) => !(config.disabled_tools ?? []).includes(tool.name))
      .filter((tool) => config.expose === "all" || (config.tools ?? []).includes(tool.name))
      .map((tool) => `${prefix}${tool.name}`);
  }

  async refreshAllProxies(): Promise<void> {
    const { refreshProxiedTools } = await import("./mcp-tool-proxy.js");
    for (const server of this.servers) {
      await refreshProxiedTools(server, this);
      server.sendToolListChanged();
    }
  }
}

export function getUpstreamManager(): McpUpstreamManager {
  if (!singleton) {
    singleton = new McpUpstreamManager();
  }
  return singleton;
}

export async function initUpstreamManager(): Promise<McpUpstreamManager> {
  const manager = getUpstreamManager();
  await manager.init();
  return manager;
}
