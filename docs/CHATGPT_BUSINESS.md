# ChatGPT Business MCP App Setup

## Recommended workflow

1. Start the local MCP server.
2. Start your HTTPS tunnel.
3. In ChatGPT Business open:

```
Workspace Settings -> Apps -> Create
```

4. Add the MCP endpoint.
5. Run **Scan Tools**.
6. Create a draft app.
7. Test from a new chat.
8. Publish only after validation.

## Updating tools

Published Business MCP apps should be treated as using a fixed tool definition snapshot. If you change tool names, schemas, or permissions:

- create a new draft app,
- scan tools again,
- test it,
- publish the updated version.

## Safety

This MCP server can provide local filesystem and shell capabilities. Treat the endpoint as privileged access to the machine running the server.
