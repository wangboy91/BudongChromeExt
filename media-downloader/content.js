/**
 * 隔离世界的内容脚本：负责把「网络层看不到的东西」上报给后台。
 *  - DOM 里的 <audio> / <video> / <source> 实际地址（含 blob:）
 *  - <a href> 指向的音频直链
 *  - performance 里已经加载过的媒体资源
 *  - 页面世界 hook 捕获到的 blob 流
 *
 * 只读取地址与标题，不读取页面数据，不做任何修改。
 */
(function () {
  const MT = globalThis.MediaTypes;
  if (!MT) return;

  /** url -> 最近一次上报的特征串，用于避免重复轰炸后台。 */
  const sent = new Map();
  let scanCount = 0;
  let frameTitle = "";

  function signature(item) {
    return [item.title || "", item.kind || "", item.ext || "", item.duration == null ? "" : Math.round(item.duration)].join("|");
  }

  function flush(items) {
    if (!items.length) return;
    const fresh = [];
    for (const item of items) {
      const sig = signature(item);
      if (sent.get(item.url) === sig) continue;
      sent.set(item.url, sig);
      fresh.push(item);
    }
    if (!fresh.length) return;
    try {
      const result = chrome.runtime.sendMessage({ cmd: "dom", items: fresh.slice(0, 120) });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (error) {
      // 扩展被重新加载后上下文会失效，忽略即可。
    }
  }

  function textOf(element) {
    const raw = element.getAttribute("title") || element.getAttribute("aria-label") || element.getAttribute("data-title") || "";
    return raw.trim().slice(0, 200);
  }

  function collect() {
    const items = [];
    const pageTitle = (document.title || frameTitle || "").trim().slice(0, 200);

    const push = (url, options) => {
      const opts = options || {};
      if (typeof url !== "string" || !url) return;
      if (!/^(https?:|blob:|data:)/i.test(url)) return;
      if (url.indexOf("data:") === 0 && url.length > 120000) return;
      const info = MT.describe({ url, mime: opts.mime, requestType: "media" });
      const item = {
        url,
        title: (opts.title || pageTitle || "").trim().slice(0, 200),
        kind: opts.kind || (info && info.kind) || "audio",
        ext: opts.ext || (info && info.ext) || "",
        mime: opts.mime || (info && info.mime) || ""
      };
      if (Number.isFinite(opts.duration) && opts.duration > 0) item.duration = opts.duration;
      if (opts.poster) item.poster = opts.poster;
      items.push(item);
    };

    // 1) 播放器元素：这是最可靠的来源，blob 流也只有这里能看到。
    for (const element of document.querySelectorAll("audio, video")) {
      const kind = element.tagName === "AUDIO" ? "audio" : "video";
      const label = textOf(element);
      const duration = Number(element.duration);
      const poster = element.getAttribute("poster") || "";
      const sources = new Set([element.currentSrc, element.src]);
      for (const source of element.querySelectorAll("source")) sources.add(source.src);
      for (const url of sources) {
        push(url, { kind, title: label, duration, poster });
      }
    }

    // 2) 直接指向音频文件的链接。大页面链接很多，只在前几次扫描里做。
    if (scanCount < 3) {
      let checked = 0;
      for (const anchor of document.querySelectorAll("a[href]")) {
        if (checked >= 800) break;
        checked += 1;
        const info = MT.describe({ url: anchor.href });
        if (!info) continue;
        push(anchor.href, { kind: info.kind, ext: info.ext, mime: info.mime, title: (anchor.textContent || "").trim().slice(0, 120) });
      }
    }

    // 3) 页面已经加载过的媒体请求（扩展中途安装、或播放器用 fetch 拉的资源）。
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries.slice(-600)) {
      const info = MT.describe({ url: entry.name });
      if (!info) continue;
      if (info.kind === "hls" || info.kind === "dash") {
        push(entry.name, { kind: info.kind, ext: info.ext, mime: info.mime, title: pageTitle });
        continue;
      }
      // 分片交给后台按播放列表目录统一隐藏，这里照常上报。
      push(entry.name, { kind: info.kind, ext: info.ext, mime: info.mime, title: pageTitle });
    }

    scanCount += 1;
    flush(items);
  }

  let scheduled = null;
  function scheduleScan(delay) {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      try {
        collect();
      } catch (error) {
        // 页面结构千奇百怪，扫描失败不影响页面。
      }
    }, delay == null ? 600 : delay);
  }

  // 页面世界 hook 抓到的 blob 流。
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    // 弹窗注入页面世界下载大文件时，把进度转发给弹窗（弹窗可能已经关了，忽略失败即可）。
    if (data.__mediaDownloaderProgress) {
      try {
        const result = chrome.runtime.sendMessage({ type: "download-progress", ...data.__mediaDownloaderProgress });
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch (error) {
        // 忽略。
      }
      return;
    }

    if (data.__mediaSniffer !== true || data.type !== "BLOB_MEDIA") return;
    try {
      const result = chrome.runtime.sendMessage({
        cmd: "blob",
        items: [{ url: data.url, mime: data.mime || "", kind: /^video\//.test(data.mime || "") ? "video" : "audio", title: document.title || frameTitle }]
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (error) {
      // 忽略。
    }
  });

  // 告诉 hook：内容脚本已就绪，可以把之前抓到的 blob 重发一遍。
  try {
    window.postMessage({ __mediaSniffer: true, type: "READY" }, "*");
  } catch (error) {
    // 忽略。
  }

  // 播放器一有动作就立刻重扫，保证「点一下播放就能下载」。
  for (const type of ["play", "playing", "loadedmetadata", "durationchange", "canplay"]) {
    document.addEventListener(type, () => scheduleScan(250), true);
  }
  document.addEventListener("DOMContentLoaded", () => scheduleScan(200), true);
  window.addEventListener("load", () => scheduleScan(400), true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleScan(300); }, true);

  const observer = new MutationObserver(() => scheduleScan(1200));
  try {
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (error) {
    // 忽略。
  }

  // 首次扫描：页面标题和播放器可能稍后才出现，所以多补几次。
  scheduleScan(0);
  setTimeout(() => scheduleScan(0), 900);
  setTimeout(() => scheduleScan(0), 2600);

  // 兜底轮询，覆盖那些既不触发 DOM 变化也不触发播放事件的情况。
  setInterval(() => {
    frameTitle = document.title || frameTitle;
    scheduleScan(0);
  }, 5000);
})();
