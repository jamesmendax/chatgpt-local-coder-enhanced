# Project work rules

Read README.md and docs/RELEASE.md before changing the release workflow. Preserve user data, credentials and unrelated work. Never stop a live MCP/tunnel to test a candidate. Use isolated fixture directories and check exact process ownership.

Install dependencies using both checked-in npm locks. Build: npm run build, then npm --prefix desktop run dist. Test: node .release-tools/verify.cjs root and desktop. Packaged acceptance is a separate Windows clean-profile operation documented in README.

Never commit real .env files, credential values, userData, command logs, node_modules or generated EXEs into source history. Do not publish or push automatically. Verify actual exit codes and assertions, not just launch acknowledgements. Preserve third-party licenses and copyright notices.
