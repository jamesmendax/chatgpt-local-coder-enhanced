# Notice

This repository is derived from the open-source project [`hoangcoderr/chatgpt-local-coder`](https://github.com/hoangcoderr/chatgpt-local-coder).

The upstream project is distributed under the MIT License. Its original copyright notice is preserved in [LICENSE](LICENSE) and must remain with copies or substantial portions of the software.

This enhanced fork is maintained by [@jamesmendax](https://github.com/jamesmendax) at [`jamesmendax/chatgpt-local-coder-enhanced`](https://github.com/jamesmendax/chatgpt-local-coder-enhanced).

This fork contains additional work and maintenance by jamesmendax and other contributors, including changes around:

- direct ChatGPT conversation-attachment saving
- ChatGPT web-oriented slim/full tool profiles
- MCP session recovery and reconnect behavior
- checkpoint/rewind support
- activity/audit logging improvements
- verified binary-file transfer with staged `.part` files, expected-size checks, and SHA256 validation
- `file_info` magic-byte/hash inspection
- expanded filesystem operations in the slim profile
- Windows OpenAI Secure MCP Tunnel helpers, including optional dual-tunnel launchers
- additional unit and integration coverage
- public-repository hardening and documentation

No OpenAI Runtime API key, tunnel identifier, MCP token, local `.env`, DPAPI secret file, generated tunnel profile, or user-specific deployment state is intended to be part of this repository.

OpenAI, ChatGPT, and related names are trademarks of their respective owners. This project is community software and is not an official OpenAI product unless explicitly stated otherwise by OpenAI.
