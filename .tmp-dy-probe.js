// 用无头 Chrome 打开抖音，抓一条真实的视频播放地址（douyinvod 等）。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dy-probe-"));
const PORT = 9333;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=1280,900",
  "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch (e) { /* retry */ }
    await sleep(400);
  }
  throw new Error("no page target");
}

(async () => {
  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const media = [];
  const apiHosts = new Map();

  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Network.requestWillBeSent") {
      const { url, type } = msg.params;
      if (/douyinvod|bytecdn|amemv|zjcdn|douyin\.com\/aweme\/v\d+\/web\/aweme\/detail/.test(url)) {
        if (media.length < 400) media.push({ url, type, headers: msg.params.request.headers });
        try {
          const host = new URL(url).hostname;
          apiHosts.set(host, (apiHosts.get(host) || 0) + 1);
        } catch (e) { /* ignore */ }
      }
    }
  });

  await new Promise((r) => ws.addEventListener("open", r));
  await send("Network.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "https://www.douyin.com/" });
  await sleep(15000);

  // 滚动一下，触发更多视频加载
  await send("Runtime.evaluate", { expression: "window.scrollBy(0, 1200)", awaitPromise: false });
  await sleep(8000);

  const state = await send("Runtime.evaluate", {
    expression: "JSON.stringify({href: location.href, title: document.title, render: !!document.getElementById('RENDER_DATA'), videos: document.querySelectorAll('video').length})",
    returnByValue: true
  });
  console.log("PAGE:", state && state.result && state.result.value);
  console.log("HOSTS:", JSON.stringify([...apiHosts.entries()]));
  console.log("MEDIA_COUNT:", media.length);
  const play = media.filter((m) => /douyinvod|bytecdn|amemv|zjcdn/.test(m.url)).slice(0, 3);
  for (const item of play) {
    console.log("URL:", item.url);
    console.log("REQ_HEADERS:", JSON.stringify(item.headers));
  }
  fs.writeFileSync("D:/NewWorkAgent/BudongChromeExt/.tmp-dy-media.json", JSON.stringify(media, null, 2));
  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((error) => {
  console.error("FAILED", error);
  chrome.kill();
  process.exit(1);
});
