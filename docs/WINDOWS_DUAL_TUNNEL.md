# Windows dual-tunnel setup

This optional setup lets two ChatGPT workspaces/accounts use separate OpenAI Secure MCP Tunnel processes while sharing one local MCP server and one `WORKSPACE_PATH`.

```text
ChatGPT role A -> tunnel health :8080 --\
                                      > local MCP :3000 -> one workspace
ChatGPT role B -> tunnel health :8081 --/
```

The roles are intentionally not isolated at the filesystem or shell layer. Both tunnels reach the same local MCP process.

## Requirements

- Windows PowerShell
- the project built with `npm run build`
- OpenAI `tunnel-client` available under `bin/` (the primary tunnel helper can install it)
- two tunnel IDs if you want two separate ChatGPT app connections
- Runtime API keys with permission to use the corresponding tunnels

## Configure `.env`

```env
PORT=3000
WORKSPACE_PATH=C:\path\to\your\project

OPENAI_TUNNEL_ID=tunnel_<primary-id>
OPENAI_TUNNEL_HEALTH_PORT=8080

OPENAI_BUSINESS_TUNNEL_ID=tunnel_<second-id>
OPENAI_BUSINESS_TUNNEL_HEALTH_PORT=8081
```

Do not commit real tunnel IDs or Runtime API keys.

## Save keys with Windows DPAPI

Primary role:

```powershell
.\save-free-key.cmd
```

Second role:

```powershell
.\save-business-key.cmd
```

The resulting files are written under `.secrets/`, which is gitignored. Windows DPAPI binds them to the current Windows user/machine.

## One-click controls

```text
start-free-plugin.cmd
stop-free-plugin.cmd
start-business-plugin.cmd
stop-business-plugin.cmd
```

The shared controller `_one-click-control.ps1` follows these rules:

- start a shared port-3000 MCP server only when one is not already healthy
- never start a second local MCP server for the second role
- start each tunnel on its own health port
- when stopping one role, keep the shared MCP server alive if the other role still appears active
- do not kill an unknown process merely because it owns a project port

## Restarting after MCP code changes

If both tunnels are active, stopping only one role does not necessarily stop the shared MCP server. To guarantee a newly built `dist/index.js` is loaded:

1. run `stop-business-plugin.cmd`
2. run `stop-free-plugin.cmd`
3. verify port 3000 is no longer the old MCP process
4. run `start-business-plugin.cmd` or `start-free-plugin.cmd`
5. start the other role if needed

## Security notes

- Both roles can operate the same local workspace and shared shell state by design.
- This is not a sandbox or tenant-isolation mechanism.
- Never expose the Admin UI port through the tunnel.
- Keep `.env`, `.secrets/`, and generated `profiles/*.yaml` private.
- Use separate tunnel IDs only to separate ChatGPT connection endpoints; they do not separate filesystem permissions.
