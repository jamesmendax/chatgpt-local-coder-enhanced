# ChatGPT Web Harness 0.1.1

This release makes the optional Windows desktop launcher self-contained and safer to deploy on a clean machine.

## Highlights

- Added a unified Skill lifecycle: project, installed, external, and builtin Skills share one resolver and registry schema.
- Added local-directory Skill installation, uninstall, and enable/disable APIs in the MCP tool surface, Admin API, and desktop Skills page.
- Added constant-time Admin token comparison and removed credential-bearing variables from arbitrary Skill child processes.
- Added truthful MCP ToolAnnotations; deletion tools are now explicitly marked destructive.
- Added an Electron Node shim so Node-based Skills can run without a system Node installation.
- Added ZIP extraction safety checks for path traversal, Windows reserved names, alternate data streams, and expansion limits.
- Added migration and reset handling for runtime profiles, while preserving installed Skills and user configuration.
- Portable, setup, and zip packages contain zero preinstalled Skills.
- Fixed a portable-launcher race that could remove files from a shared extraction directory when two launchers started together.
- Portable extraction now uses a short process-specific root and compact runtime dependency paths, so deep `%TEMP%` paths retain the complete payload.
- Added a payload manifest that blocks startup if an extracted harness tree is incomplete.
- Fixed NSIS uninstall leaving deeply nested runtime files behind on drive-letter installation paths, while preserving user data on silent uninstall.

## Downloads

| Artifact | SHA-256 |
|---|---|
| `ChatGPT Web Harness-0.1.1-portable.exe` | `48F4831D54ACB9853E7217F6E9C677CA5B8FDC3810E71DA09F214746A9929B23` |
| `ChatGPT Web Harness-0.1.1-setup.exe` | `219B31002DE840BA48129B0A4A5EF06D5B2E55B1667AE8F9F664525F4AD36BEC` |
| `ChatGPT Web Harness-0.1.1-x64.zip` | `B04AD201A379EF0AF5B6F564828653006F480BE2F9ED024A64E85E378530FEA4` |

## Verification

- Root TypeScript build: passed.
- Root canonical test suite: passed.
- Desktop smoke, migration, Node shim, ZIP safety, and payload-manifest suite: passed.
- Full desktop acceptance suite: 22/22 checks passed for the 0.1.1 artifacts, including two concurrent portable launches with complete payload manifests.

## Known limitations

- Windows executables are not code-signed. SmartScreen may therefore show an "unknown publisher" warning.
- Python-based Skill fixtures are skipped when no Python interpreter is available in the packaged environment. A clean machine with Python should rerun the packaged Python fixture.
- The release is tested on Windows x64.
