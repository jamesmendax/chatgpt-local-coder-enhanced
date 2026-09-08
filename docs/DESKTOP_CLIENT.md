# Windows desktop client

The `desktop/` directory contains the Electron launcher for ChatGPT Web Harness. It owns the setup form, encrypted local configuration, MCP/tunnel lifecycle, activity feeds, and Skill/plugin management. The MCP server remains the source of truth for tool behavior and Skill resolution.

## Build and test

From the repository root:

```powershell
npm ci
npm run build
npm --prefix desktop ci
npm --prefix desktop test
npm --prefix desktop run dist
npm --prefix desktop run dist:zip
```

The Windows artifacts are written to `desktop/release/`, which is intentionally ignored by Git. `npm --prefix desktop run acceptance` runs the isolated portable acceptance checks when a built Windows artifact is available.

## Runtime layout

- The packaged client stages the root `dist/`, production dependencies, and sanitized public profiles under its private runtime directory.
- Runtime configuration, logs, installed Skills, and temporary ZIP extraction are kept outside the repository and are not copied into a release package.
- The public package does not ship a `skills/` directory or any app-level preinstalled Skill. A user can add a directory or ZIP from the desktop UI, use the Admin API, or call the MCP lifecycle tools.
- Child processes use Electron's bundled Node executable and receive a filtered environment without MCP/Admin/Tunnel credentials.

## Portable safety

Portable mode uses ZIP-based per-launch unpacking rather than a build-id directory shared by concurrent launches. The staged `harness-files.json` manifest records the expected file set and byte count. Startup validates the manifest, file presence, and key runtime modules before creating the window or starting services; an incomplete tree fails closed with a visible error.

Staging rejects private developer paths, unsafe profile files, `local-skills/`, symbolic links, and generated release data. Setup and ZIP packages use the same staged harness and sanitization rules.

## Skill/plugin boundary

A Skill is a data-only directory containing exactly one `SKILL.md` plus optional `references/`, `workflows/`, or `scripts/` documentation. Installation copies bytes into the runtime's `local-skills/` directory and records metadata atomically; package scripts and dependencies are not executed. A plugin that provides tools must instead be configured as an upstream MCP server, where normal tool admission still applies.
