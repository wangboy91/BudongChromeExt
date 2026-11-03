const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8125;
const EXT = "D:/NewWorkAgent/BudongChromeExt/.tmp-dnr-test";
const CDP = 9446;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "16" });
  res.end(Buffer.alloc(16, 1));
});

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ws, send, open: new Promise((r) => ws.addEventListener("open", r)), on: (fn) => listeners.push(fn) };
}

server.listen(PORT, "127.0.0.1", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dnr-probe3-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  chrome.stderr.on("data", (d) => { err += String(d); });

  await sleep(4000);
  const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.open;

  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  console.log("LOAD:", JSON.stringify(loaded));
  const extId = loaded.result && loaded.result.id;
  await sleep(1500);

  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  console.log("TARGETS:", JSON.stringify(list.map((t) => ({ type: t.type, url: t.url }))));
  const sw = list.find((t) => t.type === "service_worker" && t.url.includes(extId));
  if (!sw) {
    console.log("NO SW FOR OUR EXT");
  } else {
    const swc = connect(sw.webSocketDebuggerUrl);
    await swc.open;
    const res = await swc.send("Runtime.evaluate", {
      expression: `(async () => { const rules = await chrome.declarativeNetRequest.getDynamicRules(); const r = await chrome.downloads.download({url:"http://127.0.0.1:${PORT}/file.bin", filename:"probe.bin"}).catch(e => "ERR:"+e.message); return JSON.stringify({rules, r}); })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log("SW_EVAL:", JSON.stringify(res.result));
    await sleep(2500);
  }

  console.log("REQUESTS:", JSON.stringify(seen.map((s) => ({ url: s.url, referer: s.headers.referer || null, origin: s.headers.origin || null, range: s.headers.range || null, cookie: s.headers.cookie || null })), null, 2));
  chrome.kill();
  server.close();
  if (!seen.length) console.log("CHROME_STDERR:", err.slice(0, 800));
  process.exit(0);
});
