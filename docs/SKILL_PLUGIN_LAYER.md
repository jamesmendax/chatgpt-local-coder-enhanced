# Skill and plugin lifecycle

The extension layer keeps prompt/workflow packages separate from executable tool providers.

## Skill sources and priority

The resolver can discover:

1. project Skills under `<workspace>/.claude/skills/`;
2. installed Skills under the runtime `local-skills/` directory;
3. externally registered local Skills whose registry row points to an absolute `SKILL.md`;
4. built-in Skills only when an operator deliberately supplies a repository `skills/` directory.

The public release supplies no repository `skills/` directory, so it has no app-level preinstalled Skills. When the same id appears in multiple sources, the resolver selects project, installed, external, then supplied-builtin content. Canonical ids win over aliases, and disabled or invalid rows are not selectable.

## Registry and operations

`profiles/plugins.json` uses schema version 2:

```json
{
  "schema_version": 2,
  "computer_use": { "enabled": false },
  "skills": [
    {
      "id": "example-skill",
      "source": "external",
      "path": "D:/skills/example-skill/SKILL.md",
      "enabled": true
    }
  ]
}
```

The MCP surface exposes `list_skills`, `load_skill`, `install_skill`, `uninstall_skill`, and `set_skill_enabled`. The loopback Admin API and the desktop UI use the same resolver and atomic registry writer. Disabling a Skill keeps its files; uninstalling removes only an installed package or its external registry row. Project and supplied-builtin content cannot be deleted through the lifecycle API.

The desktop UI accepts a local Skill directory or ZIP. ZIP entries are checked for traversal, device names, symbolic links, entry-count limits, and expansion limits before extraction. The installer requires exactly one `SKILL.md`, preserves package bytes, validates the id, records frontmatter metadata, and never runs package scripts. A package that provides executable tools should be adapted as an upstream MCP server instead of being installed as a Skill.

## Security and adaptation

- A Skill is instructions and reference data; loading it does not execute code.
- Child processes launched by Skill-related workflows use a filtered environment without MCP, Admin, or Tunnel credentials.
- The server does not auto-download from a public marketplace. A web client or operator may place a reviewed directory/ZIP on the machine, then use the same local installer path.
- Review a package's `SKILL.md`, references, and any requested permissions before enabling it.

Focused lifecycle checks:

```powershell
npm run build
node scripts/test-skills-plugins.mjs
node scripts/test-skill-resolution-contracts.mjs
node scripts/test-skill-installer.mjs
node scripts/test-skills-admin-api.mjs
```
