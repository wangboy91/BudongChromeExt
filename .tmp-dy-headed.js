// 有头 Chrome（临时 profile）打开抖音，抓真实播放地址
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dy-headed-"));
const CDP = 9450;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,900",
  "--window-position=80,80",
  "https://www.douyin.com/"
], { stdio: "ignore" });

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) { for (const fn of listeners) fn(msg); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ws, send, open: new Promise((r) => ws.addEventListener("open", r)), on: (fn) => listeners.push(fn) };
}

(async () => {
  await sleep(5000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("douyin"));
  if (!page) throw new Error("no douyin page: " + JSON.stringify(list.map((t) => t.url)));
  const c = connect(page.webSocketDebuggerUrl);
  await c.open;
  const urls = [];
  c.on((msg) => {
    if (msg.method === "Network.requestWillBeSent" && /douyinvod|bytecdn|amemv|zjcdn/.test(msg.params.request.url)) {
      urls.push({ url: msg.params.request.url, headers: msg.params.request.headers });
    }
  });
  await c.send("Network.enable");
  await sleep(6000);
  await c.send("Runtime.evaluate", { expression: "window.scrollBy(0, 1400)" });
  await sleep(6000);
  const state = await c.send("Runtime.evaluate", {
    expression: "JSON.stringify({href: location.href, title: document.title, videos: document.querySelectorAll('video').length})",
    returnByValue: true
  });
  console.log("PAGE:", state.result.value);
  console.log("COUNT:", urls.length);
  fs.writeFileSync("D:/NewWorkAgent/BudongChromeExt/.tmp-dy-real.json", JSON.stringify(urls.slice(0, 20), null, 2));
  for (const item of urls.slice(0, 2)) {
    console.log("URL:", item.url.slice(0, 300));
    console.log("HDR:", JSON.stringify(item.headers).slice(0, 400));
  }
  chrome.kill();
  process.exit(0);
})().catch(async (error) => {
  console.error("FAILED", error.message);
  chrome.kill();
  process.exit(1);
});
