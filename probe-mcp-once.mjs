/** Speak MCP over real stdio: count registered tools and call one for real. */
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/bin/mcp-stdio.js"], {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, RIPAR_NETWORK: "testnet" },
});
let buf = "";
const pending = new Map();
let id = 1;
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++; pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => rej(new Error(`${method} timed out`)), 25000);
});

try {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = (await send("tools/list")).result?.tools ?? [];
  const call = await send("tools/call", { name: "ripar_get_agent", arguments: { agentId: 1 } });
  const text = call.result?.content?.[0]?.text ?? "";
  console.log(`tools=${tools.length}`);
  console.log(text.slice(0, 200).replace(/\s+/g, " "));
} finally {
  child.kill();
}
