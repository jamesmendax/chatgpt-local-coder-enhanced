import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

if (process.platform !== "win32") {
  console.log("office-visual-review: SKIP (Windows Office automation is unavailable)");
  process.exit(0);
}

process.env.CHATGPT_TOOL_PROFILE = "slim";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "office-visual-review");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");

function runPowerShell(script, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exit ${code}`));
    });
  });
}

async function processIds(name) {
  const raw = await runPowerShell(`(Get-Process ${name} -ErrorAction SilentlyContinue).Id -join ','`, 10_000).catch(() => "");
  return String(raw).split(",").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
}

async function cleanupNewProcesses(name, before) {
  const old = new Set(before);
  for (const pid of await processIds(name)) {
    if (!old.has(pid)) {
      await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`, 10_000).catch(() => undefined);
    }
  }
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function data(result) {
  if (!result?.structuredContent?.ok) throw new Error(JSON.stringify(result?.structuredContent || result));
  return result.structuredContent.data;
}

function imageBlocks(result) {
  return (result.content || []).filter((block) => block.type === "image");
}

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const beforePowerPoint = await processIds("POWERPNT");
const beforeWord = await processIds("WINWORD");
let server;
let client;

try {
  const { createMcpServer } = await import("../dist/server-factory.js");
  server = createMcpServer(workspace, 30_000, [workspace], true);
  client = new Client({ name: "office-visual-review-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  if (beforePowerPoint.length === 0) {
    const pptxPath = path.join(workspace, "sample.pptx");
    try {
      await runPowerShell(`
$ErrorActionPreference='Stop'
$app=$null;$presentation=$null
try {
  $app=New-Object -ComObject PowerPoint.Application
  $presentation=$app.Presentations.Add()
  $slide=$presentation.Slides.Add(1,12)
  $shape=$slide.Shapes.AddTextbox(1,90,80,760,130)
  $shape.TextFrame.TextRange.Text='Universal Visual Review'
  $shape.TextFrame.TextRange.Font.Size=34
  $panel=$slide.Shapes.AddShape(1,100,240,700,220)
  $panel.Fill.ForeColor.RGB=0x55AA33
  $presentation.SaveAs(${psQuote(pptxPath)},24)
} finally {
  if($presentation){$presentation.Close()}
  if($app){$app.Quit()}
}`, 90_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await cleanupNewProcesses("POWERPNT", beforePowerPoint);
      const reviewed = await client.callTool({
        name: "visual_review",
        arguments: { target: pptxPath, pages: [1], width: 1200, height: 675, timeout_ms: 90_000 },
      });
      const reviewedData = data(reviewed);
      if (reviewedData.kind !== "pptx" || reviewedData.page_paths.length !== 1 || imageBlocks(reviewed).length < 1) {
        throw new Error("PowerPoint visual review did not return a rendered slide");
      }
      console.log("OK PowerPoint COM export -> visual_review pixels");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid class string|class not registered|cannot create activex/i.test(message)) {
        console.log(`office-visual-review: SKIP PowerPoint (${message.slice(0, 160)})`);
      } else {
        throw error;
      }
    } finally {
      await cleanupNewProcesses("POWERPNT", beforePowerPoint);
    }
  } else {
    console.log("office-visual-review: SKIP PowerPoint (user PowerPoint session is already running)");
  }

  if (beforeWord.length > 0) {
    const docxPath = path.join(workspace, "busy-word.docx");
    await fs.writeFile(docxPath, Buffer.from("not opened because the safety guard runs first"));
    const refused = await client.callTool({
      name: "visual_review",
      arguments: { target: docxPath, timeout_ms: 20_000 },
    });
    if (refused.structuredContent?.ok !== false || !JSON.stringify(refused).includes("WINWORD is already running")) {
      throw new Error("DOCX visual review did not protect the existing Word session");
    }
    console.log("OK Word safety guard refused to attach to an existing user session");
  } else {
    const docxPath = path.join(workspace, "sample.docx");
    try {
      await runPowerShell(`
$ErrorActionPreference='Stop'
$app=$null;$document=$null
try {
  $app=New-Object -ComObject Word.Application
  $app.Visible=$false
  $app.DisplayAlerts=0
  $document=$app.Documents.Add()
  $document.Content.Text='Universal Visual Review' + [Environment]::NewLine + 'Word page rendering evidence.'
  $document.SaveAs2(${psQuote(docxPath)},16)
} finally {
  if($document){$document.Close($false)}
  if($app){$app.Quit()}
}`, 90_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await cleanupNewProcesses("WINWORD", beforeWord);
      const reviewed = await client.callTool({
        name: "visual_review",
        arguments: { target: docxPath, pages: [1], width: 1000, height: 1000, timeout_ms: 90_000 },
      });
      const reviewedData = data(reviewed);
      if (reviewedData.kind !== "docx" || reviewedData.page_paths.length !== 1 || imageBlocks(reviewed).length < 1) {
        throw new Error("Word visual review did not return a rendered page");
      }
      console.log("OK Word COM -> PDF -> visual_review pixels");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid class string|class not registered|cannot create activex/i.test(message)) {
        console.log(`office-visual-review: SKIP Word (${message.slice(0, 160)})`);
      } else {
        throw error;
      }
    } finally {
      await cleanupNewProcesses("WINWORD", beforeWord);
    }
  }
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await cleanupNewProcesses("POWERPNT", beforePowerPoint);
  await cleanupNewProcesses("WINWORD", beforeWord);
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log("office-visual-review: Office rendering/safety behavior OK");