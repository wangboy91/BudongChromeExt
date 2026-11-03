// 对照实验：同一条 DNR 规则对「页面请求」是否生效
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8126;
const EXT = "D:/NewWorkAgent/BudongChromeExt/.tmp-dnr-test";
const CDP = 9447;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>hi</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "16" });
  res.end(Buffer.alloc(16, 1));
});

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ws, send, open: new Promise((r) => ws.addEventListener("open", r)) };
}

server.listen(PORT, "127.0.0.1", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dnr-probe4-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  await sleep(4000);
  const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.open;
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId = loaded.result.id;
  await sleep(1200);

  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  const pageC = connect(page.webSocketDebuggerUrl);
  await pageC.open;
  await pageC.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/page` });
  await sleep(1200);
  const sw = list.find((t) => t.type === "service_worker" && t.url.includes(extId));
  const swC = connect(sw.webSocketDebuggerUrl);
  await swC.open;
  const res2 = await swC.send("Runtime.evaluate", {
    expression: `fetch("http://127.0.0.1:${PORT}/extfetch").then(r => r.status).catch(e => "ERR:" + e.message)`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log("EXT_FETCH:", JSON.stringify(res2.result));
  await sleep(1200);

  console.log("REQUESTS:", JSON.stringify(seen.map((s) => ({ url: s.url, referer: s.headers.referer || null, origin: s.headers.origin || null })), null, 2));
  chrome.kill();
  server.close();
  process.exit(0);
});
