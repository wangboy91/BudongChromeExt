const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8124;
const EXT = "D:/NewWorkAgent/BudongChromeExt/.tmp-dnr-test";
const CDP = 9445;

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "16" });
  res.end(Buffer.alloc(16, 1));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(PORT, "127.0.0.1", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dnr-probe2-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let err = "";
  chrome.stderr.on("data", (d) => { err += String(d); });

  await sleep(6000);
  let list = [];
  try {
    list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  } catch (e) { err += "\njson/list failed: " + e.message; }
  console.log("TARGETS:", JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })), null, 2));

  const sw = list.find((t) => t.type === "service_worker");
  if (sw) {
    const ws = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    let id = 0;
    const send = (method, params) => new Promise((resolve) => {
      const msgId = ++id;
      const onMsg = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === msgId) { ws.removeEventListener("message", onMsg); resolve(msg); }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    const res = await send("Runtime.evaluate", {
      expression: `(async () => { const rules = await chrome.declarativeNetRequest.getDynamicRules(); const r = await chrome.downloads.download({url:"http://127.0.0.1:${PORT}/file.bin", filename:"probe.bin"}).catch(e => "ERR:"+e.message); return JSON.stringify({rules, r}); })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log("SW_EVAL:", JSON.stringify(res.result));
    ws.close();
  } else {
    console.log("NO SERVICE WORKER TARGET");
  }

  await sleep(2500);
  console.log("REQUESTS:", JSON.stringify(seen.map((s) => ({ url: s.url, referer: s.headers.referer || null, origin: s.headers.origin || null, range: s.headers.range || null })), null, 2));
  chrome.kill();
  server.close();
  if (!seen.length) console.log("CHROME_STDERR:", err.slice(0, 1500));
  process.exit(0);
});
