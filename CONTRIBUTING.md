# Contributing

Thanks for helping improve ChatGPT Local Coder.

## Before you start

This project exposes local filesystem and shell capabilities through MCP. Changes that widen permissions, weaken authentication, expose the Admin UI, or alter destructive-tool behavior deserve extra review and tests.

## Development setup

```powershell
npm ci
npm run build
npm run test:all
```

Before opening a pull request, run:

```powershell
npm run verify
```

## Pull requests

Please keep pull requests focused and include:

- what changed and why
- security/permission impact, if any
- tests added or updated
- platform tested (Windows/macOS/Linux)
- any ChatGPT/MCP behavior that requires users to recreate or republish an app

## Security and secrets

Never commit or paste:

- `.env`
- `.secrets/`
- Runtime API keys
- tunnel IDs from a real deployment
- connector URLs containing `MCP_TOKEN`
- personal filesystem paths or private project contents
- generated tunnel profiles with real identifiers

Run `npm run check:secrets` before pushing. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Style

- Keep TypeScript changes type-safe and buildable with `npm run build`.
- Prefer adding regression tests for bugs.
- Preserve existing security checks such as `validatePath()` and `requireWriteAllowed()` unless the change is explicitly about the permission model.
- Keep documentation synchronized with tool names and schemas.

## Upstream attribution

This repository is derived from `hoangcoderr/chatgpt-local-coder`. Do not remove the upstream MIT copyright notice or [NOTICE.md](NOTICE.md).
