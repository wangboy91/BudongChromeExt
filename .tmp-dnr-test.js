// 验证：DNR 能否改写 chrome.downloads.download 发起的请求头（Referer / Range）
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8123;
const LOG = "D:/NewWorkAgent/BudongChromeExt/.tmp-dnr-requests.json";
const EXT = "D:/NewWorkAgent/BudongChromeExt/.tmp-dnr-test";

fs.rmSync(EXT, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });

fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify({
  manifest_version: 3,
  name: "dnr-probe",
  version: "1.0",
  permissions: ["declarativeNetRequest", "downloads"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "bg.js" }
}, null, 2));

fs.writeFileSync(path.join(EXT, "bg.js"), `
chrome.runtime.onInstalled.addListener(go);
go();

async function go() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: "https://www.douyin.com/" },
          { header: "origin", operation: "set", value: "https://www.douyin.com" }
        ]
      },
      condition: { urlFilter: "127.0.0.1:8123", resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "object", "other", "image", "script", "stylesheet", "font", "ping", "csp_report", "websocket", "webtransport", "webbundle"] }
    }]
  });
  await new Promise((r) => setTimeout(r, 500));
  try {
    const id = await chrome.downloads.download({ url: "http://127.0.0.1:${PORT}/file.bin", filename: "probe.bin", saveAs: false });
    console.log("download started", id);
  } catch (error) {
    console.log("download failed", String(error));
  }
}
`);

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  fs.writeFileSync(LOG, JSON.stringify(seen, null, 2));
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="file.bin"',
    "content-length": "16"
  });
  res.end(Buffer.alloc(16, 1));
});

server.listen(PORT, "127.0.0.1", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dnr-probe-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9444",
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    "--disable-extensions-except=" + EXT,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore" });

  await new Promise((r) => setTimeout(r, 9000));
  chrome.kill();
  server.close();
  console.log("REQUESTS:", JSON.stringify(seen.map((s) => ({ url: s.url, referer: s.headers.referer || null, origin: s.headers.origin || null, range: s.headers.range || null, ua: (s.headers["user-agent"] || "").slice(0, 40) })), null, 2));
  process.exit(0);
});
