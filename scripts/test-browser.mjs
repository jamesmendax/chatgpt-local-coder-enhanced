import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".browser-test-tmp");
await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });
const htmlPath = path.join(tmpDir, "browser.html");
await fs.writeFile(
  htmlPath,
  `<!doctype html><html><body><input id="name"><button id="go">Go</button><div id="out"></div><script>
  document.querySelector('#go').addEventListener('click',()=>{const v=document.querySelector('#name').value;document.querySelector('#out').textContent='Hello '+v;console.error('qa-marker:'+v)});
  </script></body></html>`
);

function requireImage(result, label) {
  const block = result.content?.find((item) => item.type === "image");
  if (!block?.data) throw new Error(`${label}: image block missing`);
}

const server = createMcpServer(tmpDir, 30_000, [tmpDir], true);
const client = new Client({ name: "browser-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const opened = await client.callTool({ name: "browser_open", arguments: { target: htmlPath, width: 800, height: 500 } });
  requireImage(opened, "browser_open");
  const sessionId = opened.structuredContent?.data?.session_id;
  if (!sessionId) throw new Error("browser_open: session_id missing");

  const filled = await client.callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "fill", selector: "#name", text: "CodexLoop", screenshot: false },
  });
  if (!filled.structuredContent?.ok) throw new Error("fill failed");

  const clicked = await client.callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "click", selector: "#go", screenshot: true },
  });
  requireImage(clicked, "browser_action click");
  const excerpt = clicked.structuredContent?.data?.text_excerpt || "";
  if (!String(excerpt).includes("Hello CodexLoop")) throw new Error(`DOM state not updated: ${excerpt}`);
  const errors = clicked.structuredContent?.data?.console_errors || [];
  if (!JSON.stringify(errors).includes("qa-marker:CodexLoop")) throw new Error("console diagnostics missing");

  const evaluated = await client.callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "evaluate", script: "document.querySelector('#out').textContent", screenshot: false },
  });
  if (evaluated.structuredContent?.data?.action_result !== "Hello CodexLoop") throw new Error("evaluate returned wrong value");

  const closed = await client.callTool({ name: "browser_close", arguments: { session_id: sessionId } });
  if (!closed.structuredContent?.data?.closed || closed.structuredContent?.data?.active_sessions !== 0) {
    throw new Error("browser session did not close cleanly");
  }

  console.log("OK browser session opened, filled, clicked, captured image+console, evaluated DOM, and released browser resources");
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
}
