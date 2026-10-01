/**
 * 弹窗逻辑：列表渲染 + 三种下载路径。
 *  - 直链（http/https）：交给 Chrome 下载管理器
 *  - blob:（页面内存流）：请页面世界读成 data URL 再下载
 *  - HLS(.m3u8)：解析播放列表 -> 拉取分片 -> 解密(AES-128) -> 拼接成单个文件
 */
(function () {
  const MT = globalThis.MediaTypes;
  const BLOB_INLINE_LIMIT = 32 * 1024 * 1024;
  /** 直接用浏览器打开 popup.html 调试时没有 chrome API，走降级提示。 */
  const HAS_CHROME = typeof chrome !== "undefined" && Boolean(chrome.runtime) && Boolean(chrome.tabs) && Boolean(chrome.downloads);

  const els = {
    list: document.getElementById("list"),
    count: document.getElementById("count"),
    subtitle: document.getElementById("subtitle"),
    status: document.getElementById("status"),
    statusDot: document.querySelector(".status-dot"),
    refresh: document.getElementById("refresh"),
    clear: document.getElementById("clear"),
    downloadAll: document.getElementById("download-all"),
    filters: document.getElementById("filters"),
    progress: document.getElementById("progress"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    meta: document.getElementById("meta"),
    metaPlatform: document.getElementById("meta-platform"),
    metaAuthor: document.getElementById("meta-author"),
    metaCaption: document.getElementById("meta-caption"),
    metaCopy: document.getElementById("meta-copy"),
    preview: document.getElementById("preview"),
    previewKind: document.getElementById("preview-kind"),
    previewTitle: document.getElementById("preview-title"),
    previewBody: document.getElementById("preview-body"),
    previewOpen: document.getElementById("preview-open"),
    previewClose: document.getElementById("preview-close"),
    askSave: document.getElementById("ask-save"),
    showSegments: document.getElementById("show-segments"),
    counts: {
      all: document.getElementById("count-all"),
      audio: document.getElementById("count-audio"),
      video: document.getElementById("count-video"),
      stream: document.getElementById("count-stream")
    }
  };

  const state = {
    tabId: null,
    pageUrl: "",
    pageTitle: "",
    items: [],
    filter: "all",
    showSegments: false,
    askSave: false,
    busy: false,
    pending: 0,
    player: null,
    playingUrl: "",
    platform: null,
    platformMeta: null
  };

  /* ------------------------------------------------------------ 小工具 */

  const KIND_ORDER = { audio: 0, hls: 1, video: 2, dash: 3 };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatus(text, tone) {
    els.status.textContent = text;
    els.statusDot.classList.toggle("is-busy", tone === "busy");
    els.statusDot.classList.toggle("is-error", tone === "error");
  }

  function setProgress(percent, text) {
    if (percent == null) {
      els.progress.hidden = true;
      return;
    }
    els.progress.hidden = false;
    els.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    els.progressText.textContent = text || `${Math.round(percent)}%`;
  }

  function shortHash(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36).padStart(6, "0").slice(0, 6);
  }

  /** 平台适配器读到的标题优先于页面 <title>，因为它更干净。 */
  function fallbackTitle() {
    const meta = state.platformMeta;
    if (meta && meta.title) return String(meta.title).trim();
    return (state.pageTitle || "").trim();
  }

  /** 尽量给条目取一个有意义的名字，取不到就退回页面标题。 */
  function deriveTitle(item) {
    const fallback = fallbackTitle();
    const itemTitle = (item.title || "").trim();
    if (itemTitle && itemTitle !== state.pageTitle && itemTitle !== fallback) return itemTitle;
    if (item.fileName) {
      const fromHeader = item.fileName.replace(/\.[a-z0-9]{1,6}$/i, "").trim();
      if (fromHeader) return fromHeader;
    }
    try {
      const url = new URL(item.url);
      const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      const base = last.replace(/\.[a-z0-9]{1,6}$/i, "");
      // 纯字母数字的长串是不透明 ID（抖音 CDN 常见），拿它当名字还不如用页面标题。
      const opaque = base.length >= 24 && /^[A-Za-z0-9]+$/.test(base);
      if (base.length >= 3 && !opaque && !/^(index|play|audio|media|stream|default|master|manifest|out|file)$/i.test(base)) {
        return base;
      }
      if (url.search) {
        const params = new URLSearchParams(url.search);
        for (const key of ["filename", "file", "name", "title", "voiceName", "voice_name"]) {
          const value = params.get(key);
          if (value) return value;
        }
      }
    } catch (error) {
      // blob:/data: 之类解析不出路径，直接用标题。
    }
    return itemTitle || fallback || "音视频";
  }

  function extensionFor(item) {
    if (item.ext) return item.ext;
    const fromUrl = MT.extFromUrl(item.url);
    if (fromUrl) return fromUrl;
    if (item.kind === "hls") return "ts";
    if (item.kind === "dash") return "mpd";
    if (item.kind === "video") return "mp4";
    return "mp3";
  }

  function filenameFor(item) {
    const ext = extensionFor(item);
    const adapter = state.platform;
    // 平台适配器只管「基名」，扩展名统一由这里补，避免截断时把后缀切掉。
    if (adapter && typeof adapter.filename === "function" && state.platformMeta) {
      try {
        const custom = adapter.filename({
          meta: state.platformMeta,
          item,
          ext,
          clean: (value, limit) => MT.sanitizeFilename(value, limit),
          fallbackBase: MT.basename(deriveTitle(item), "音视频")
        });
        if (custom) return `${MT.sanitizeFilename(custom, 160)}.${ext}`;
      } catch (error) {
        // 适配器出错就退回通用命名，不影响下载。
      }
    }
    const base = MT.basename(deriveTitle(item), "音视频");
    const host = MT.hostLabel(item.url) || MT.hostLabel(state.pageUrl);
    const parts = [base];
    if (host && !base.toLowerCase().includes(host.toLowerCase())) parts.push(host);
    parts.push(shortHash(item.url));
    return `${parts.join("-")}.${ext}`.slice(0, 180);
  }

  function isPreviewable(item) {
    if (item.kind === "hls" || item.kind === "dash") return false;
    return /^https?:/i.test(item.url);
  }

  /** 试听/预览按钮的说明文字：讲清楚有些条目为什么点不了。 */
  function previewHint(item) {
    if (isPreviewable(item)) return item.kind === "video" ? "预览视频" : "试听";
    if (isLive(item)) return "流媒体要先下载才能播放";
    return "内存流无法直接预览，请先下载";
  }

  function isLive(item) {
    return item.kind === "hls" || item.kind === "dash";
  }

  /* ------------------------------------------------------------ 列表渲染 */

  function allVisible() {
    return state.items.filter((item) => state.showSegments || !item.hidden);
  }

  function filtered() {
    const items = allVisible();
    const picked = state.filter === "all"
      ? items
      : state.filter === "stream"
        ? items.filter((item) => isLive(item))
        : items.filter((item) => item.kind === state.filter);
    return picked.slice().sort((a, b) => {
      const order = (KIND_ORDER[a.kind] == null ? 9 : KIND_ORDER[a.kind]) - (KIND_ORDER[b.kind] == null ? 9 : KIND_ORDER[b.kind]);
      if (order) return order;
      return (b.ts || 0) - (a.ts || 0);
    });
  }

  function metaParts(item) {
    const parts = [];
    const host = MT.hostLabel(item.url);
    if (host) parts.push({ text: host, className: "tag" });
    if (item.mime) parts.push({ text: item.mime });
    const size = MT.formatBytes(item.size);
    if (size) parts.push({ text: item.partial ? `${size}（估算）` : size, className: item.partial ? "warn" : "" });
    const duration = MT.formatDuration(item.duration);
    if (duration) parts.push({ text: duration });
    if (item.source === "blob") parts.push({ text: "内存流", className: "warn" });
    else if (item.source === "dom") parts.push({ text: "页面元素" });
    if (item.kind === "hls") parts.push({ text: "HLS 播放列表" });
    if (item.kind === "dash") parts.push({ text: "DASH 播放列表", className: "warn" });
    if (item.hidden) parts.push({ text: "分片", className: "warn" });
    return parts;
  }

  function makeRow(item) {
    const row = el("article", "row");
    if (state.playingUrl === item.url) row.classList.add("is-playing");

    const badge = el("span", "fmt");
    const ext = (item.ext || MT.extFromUrl(item.url) || "").toUpperCase();
    badge.textContent = ext ? ext.slice(0, 4) : item.kind === "hls" ? "HLS" : item.kind === "dash" ? "MPD" : item.kind === "video" ? "VID" : "AUD";
    if (item.kind === "video") badge.classList.add("is-video");
    if (isLive(item)) badge.classList.add("is-stream");
    if (item.url.startsWith("blob:")) badge.classList.add("is-blob");

    const body = el("div", "row-body");
    const name = el("div", "name", deriveTitle(item));
    name.title = item.url;
    const meta = el("div", "meta");
    for (const part of metaParts(item)) {
      if (part.className === "tag" && meta.childElementCount) meta.append(el("span", "", "·"));
      meta.append(el("span", part.className || "", part.text));
    }
    body.append(name, meta);

    const actions = el("div", "row-actions");

    const play = el("button", "mini", state.playingUrl === item.url ? "⏸" : "▶");
    play.type = "button";
    play.title = previewHint(item);
    play.setAttribute("aria-label", previewHint(item));
    play.disabled = !isPreviewable(item);
    play.addEventListener("click", () => togglePreview(item));

    const copy = el("button", "mini", "⧉");
    copy.type = "button";
    copy.title = "复制地址";
    copy.setAttribute("aria-label", "复制地址");
    copy.addEventListener("click", () => copyUrl(item.url));

    const download = el("button", "mini download", "↓ 下载");
    download.type = "button";
    download.setAttribute("aria-label", "下载");
    download.addEventListener("click", async () => {
      download.disabled = true;
      download.textContent = "处理中…";
      state.pending += 1;
      try {
        await runDownload(item);
        download.textContent = "✓ 已提交";
      } catch (error) {
        download.textContent = "重试下载";
        download.disabled = false;
        setStatus(error && error.message ? error.message : "下载失败，请重试。", "error");
      } finally {
        state.pending -= 1;
        setProgress(null);
      }
    });

    actions.append(play, copy, download);
    row.append(badge, body, actions);
    return row;
  }

  function showEmpty(title, detail) {
    els.list.replaceChildren();
    const box = el("div", "empty");
    box.append(el("strong", "", title), el("p", "", detail));
    els.list.append(box);
    els.count.textContent = "0";
  }

  function render() {
    const items = filtered();
    const visible = allVisible();
    const counts = {
      all: visible.length,
      audio: visible.filter((item) => item.kind === "audio").length,
      video: visible.filter((item) => item.kind === "video").length,
      stream: visible.filter((item) => isLive(item)).length
    };
    for (const key of Object.keys(els.counts)) els.counts[key].textContent = String(counts[key]);
    els.count.textContent = String(items.length);

    const scrollTop = els.list.scrollTop;
    if (!visible.length) {
      showEmpty("还没有检测到音视频", "在页面上点一下播放按钮，或稍等片刻再点右上角的「重新检测」。");
    } else if (!items.length) {
      showEmpty("当前筛选下没有资源", "换个分类看看，或者勾选底部的「显示流分片」。");
    } else {
      const fragment = document.createDocumentFragment();
      for (const item of items) fragment.append(makeRow(item));
      els.list.replaceChildren(fragment);
      els.list.scrollTop = scrollTop;
    }
    els.downloadAll.disabled = state.busy || !items.length;
  }

  /* ---------------------------------------------------------------- 下载 */

  async function saveUrl(url, filename) {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: state.askSave,
      conflictAction: "uniquify"
    });
    if (typeof downloadId !== "number") throw new Error("Chrome 没有开始下载。");
    return downloadId;
  }

  async function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      return await saveUrl(url, filename);
    } finally {
      // 给下载管理器留出读取时间，之后再回收内存。
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  }

  /** 在页面世界执行：把 blob 读成 data URL；太大则退回页面原生保存。 */
  async function pageBlobToDataUrl(url, maxBytes) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return { method: "anchor", size: blob.size };
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("读取失败"));
      reader.readAsDataURL(blob);
    });
    return { method: "data", dataUrl, size: blob.size, type: blob.type || "" };
  }

  async function downloadBlob(item, filename) {
    const frameId = typeof item.frameId === "number" ? item.frameId : 0;
    setStatus("正在读取页面内存流…", "busy");
    const injected = await chrome.scripting.executeScript({
      target: { tabId: state.tabId, frameIds: [frameId] },
      world: "MAIN",
      func: pageBlobToDataUrl,
      args: [item.url, BLOB_INLINE_LIMIT]
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result) throw new Error("页面没有返回数据，可能已经切换了内容。");
    if (result.method === "anchor") {
      setStatus(`文件较大（${MT.formatBytes(result.size) || "未知"}），已交给页面保存。`);
      return;
    }
    try {
      await saveUrl(result.dataUrl, filename);
    } catch (error) {
      // 个别 Chrome 版本不接受 data: 直链，退化成扩展自己的 blob 地址。
      const blob = await (await fetch(result.dataUrl)).blob();
      await saveBlob(blob, filename);
    }
  }

  function parseAttributes(text) {
    const attributes = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(text);
    while (match) {
      let value = match[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      attributes[match[1]] = value;
      match = pattern.exec(text);
    }
    return attributes;
  }

  function absolute(base, relative) {
    try {
      return new URL(relative, base).href;
    } catch (error) {
      return relative;
    }
  }

  async function fetchText(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`播放列表请求失败 (HTTP ${response.status})`);
    return response.text();
  }

  /** 主播放列表 -> 选一路码率最高的（优先纯音频） -> 返回媒体播放列表。 */
  async function resolvePlaylist(url) {
    let base = url;
    let text = await fetchText(base);
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const lines = text.split(/\r?\n/);
      const variants = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
        const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
        let next = "";
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const candidate = lines[cursor].trim();
          if (candidate && candidate[0] !== "#") { next = candidate; break; }
        }
        if (next) {
          variants.push({
            url: absolute(base, next),
            bandwidth: Number(attributes.BANDWIDTH || 0),
            codecs: attributes.CODECS || ""
          });
        }
      }
      if (!variants.length) throw new Error("播放列表里没有可用的流。");
      const audioOnly = variants.filter((variant) =>
        /mp4a|opus|ec-3|ac-3|flac/i.test(variant.codecs) && !/(avc1|hvc1|hev1|vp0?9|av01)/i.test(variant.codecs)
      );
      const pool = (audioOnly.length ? audioOnly : variants).slice().sort((a, b) => b.bandwidth - a.bandwidth);
      base = pool[0].url;
      text = await fetchText(base);
    }
    return { text, base };
  }

  function parseMediaPlaylist(text, base) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let key = null;
    let mapUrl = "";
    let mediaSequence = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        mediaSequence = Number(line.split(":")[1]) || 0;
      } else if (line.startsWith("#EXT-X-KEY")) {
        const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
        const method = (attributes.METHOD || "").toUpperCase();
        key = method && method !== "NONE"
          ? { method, uri: attributes.URI ? absolute(base, attributes.URI) : "", iv: attributes.IV || "" }
          : null;
      } else if (line.startsWith("#EXT-X-MAP")) {
        const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
        if (attributes.URI) mapUrl = absolute(base, attributes.URI);
      } else if (line.startsWith("#")) {
        continue;
      } else {
        segments.push({ url: absolute(base, line), key, seq: mediaSequence + segments.length });
      }
    }
    const isFmp4 = Boolean(mapUrl) || segments.some((segment) => /\.(m4s|mp4|cmfv|cmfa)(\?|$)/i.test(segment.url));
    return { segments, mapUrl, isFmp4 };
  }

  function hexToBytes(hex) {
    const clean = String(hex).replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16 && index * 2 + 1 < clean.length; index += 1) {
      bytes[index] = parseInt(clean.substr(index * 2, 2), 16);
    }
    return bytes;
  }

  function sequenceIv(sequence) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sequence >>> 0, false);
    return iv;
  }

  async function runPool(items, limit, worker) {
    let cursor = 0;
    const runners = [];
    for (let index = 0; index < Math.min(limit, items.length); index += 1) {
      runners.push((async () => {
        for (;;) {
          const current = cursor;
          cursor += 1;
          if (current >= items.length) return;
          await worker(items[current], current);
        }
      })());
    }
    await Promise.all(runners);
  }

  async function downloadHls(item, filename) {
    setStatus("正在解析 HLS 播放列表…", "busy");
    setProgress(3, "解析播放列表…");
    const { text, base } = await resolvePlaylist(item.url);
    const { segments, mapUrl, isFmp4 } = parseMediaPlaylist(text, base);
    if (!segments.length) throw new Error("播放列表里没有分片，可能是直播流，暂时无法保存。");

    const keyCache = new Map();
    async function decrypt(buffer, keyInfo, sequence) {
      if (!keyInfo) return buffer;
      const method = keyInfo.method.toUpperCase();
      if (method !== "AES-128") throw new Error(`暂不支持 ${keyInfo.method} 加密的流。`);
      let rawKey = keyCache.get(keyInfo.uri);
      if (!rawKey) {
        const response = await fetch(keyInfo.uri, { credentials: "include" });
        if (!response.ok) throw new Error(`密钥请求失败 (HTTP ${response.status})`);
        rawKey = await response.arrayBuffer();
        keyCache.set(keyInfo.uri, rawKey);
      }
      const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
      const iv = keyInfo.iv ? hexToBytes(keyInfo.iv) : sequenceIv(sequence);
      return crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buffer);
    }

    const total = segments.length + (mapUrl ? 1 : 0);
    const parts = new Array(total);
    let done = 0;
    const offset = mapUrl ? 1 : 0;

    if (mapUrl) {
      const response = await fetch(mapUrl, { credentials: "include" });
      if (!response.ok) throw new Error(`初始化分片请求失败 (HTTP ${response.status})`);
      parts[0] = await response.arrayBuffer();
      done += 1;
    }

    await runPool(segments, 4, async (segment, index) => {
      const response = await fetch(segment.url, { credentials: "include" });
      if (!response.ok) throw new Error(`分片请求失败 (HTTP ${response.status})`);
      const buffer = await response.arrayBuffer();
      parts[offset + index] = await decrypt(buffer, segment.key, segment.seq);
      done += 1;
      setProgress(3 + (done / total) * 92, `合并分片 ${done}/${total}`);
    });

    setProgress(97, "写入文件…");
    const isVideo = item.kind === "video";
    const mime = isFmp4 ? (isVideo ? "video/mp4" : "audio/mp4") : "video/mp2t";
    const blob = new Blob(parts, { type: mime });
    const finalName = `${filename.replace(/\.[a-z0-9]+$/i, "")}${isFmp4 ? (isVideo ? ".mp4" : ".m4a") : ".ts"}`;
    await saveBlob(blob, finalName);
    setStatus(`已合并 ${segments.length} 个分片（${MT.formatBytes(blob.size)}），保存为 ${finalName}。`);
  }

  async function runDownload(item) {
    const filename = filenameFor(item);
    if (item.kind === "dash") {
      throw new Error("DASH(.mpd) 需要 ffmpeg 才能合并，请先点「⧉」复制地址。");
    }
    if (item.url.startsWith("blob:")) {
      await downloadBlob(item, filename);
      setStatus("已提交下载（来自页面内存流）。");
      return;
    }
    if (item.kind === "hls") {
      await downloadHls(item, filename);
      return;
    }
    await saveUrl(item.url, filename);
    setStatus(`已交给 Chrome 下载：${filename}`);
  }

  async function downloadAll() {
    const items = filtered();
    if (!items.length) return;
    state.busy = true;
    els.downloadAll.disabled = true;
    els.downloadAll.textContent = "下载中…";
    let ok = 0;
    let failed = 0;
    for (let index = 0; index < items.length; index += 1) {
      setStatus(`批量下载 ${index + 1}/${items.length}…`, "busy");
      try {
        await runDownload(items[index]);
        ok += 1;
      } catch (error) {
        failed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    state.busy = false;
    els.downloadAll.textContent = "全部下载";
    els.downloadAll.disabled = false;
    setProgress(null);
    setStatus(`批量下载完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ""}。`, failed ? "error" : "ok");
  }

  /* ------------------------------------------------------------ 预览播放 */

  function stopPreview() {
    const player = state.player;
    if (player) {
      try {
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch (error) {
        // 元素可能已经被移除，忽略。
      }
    }
    state.player = null;
    state.playingUrl = "";
    els.previewBody.replaceChildren();
    els.preview.hidden = true;
  }

  /** 音频用原生 <audio>，视频用 <video>，两者都带完整控件（进度、音量、全屏）。 */
  function startPreview(item) {
    stopPreview();
    const isVideo = item.kind === "video";
    const player = document.createElement(isVideo ? "video" : "audio");
    player.controls = true;
    player.autoplay = true;
    player.preload = "auto";
    if (isVideo) {
      player.playsInline = true;
      player.setAttribute("playsinline", "");
    }
    player.src = item.url;

    player.addEventListener("error", () => {
      // 用元素本身做身份校验：stopPreview 会清空 src 并触发一次 error，
      // 那时 state.player 已经换人（或为 null），不该影响新一次的预览。
      if (state.player !== player) return;
      stopPreview();
      render();
      // 弹窗是 chrome-extension:// 源，部分站点（抖音 CDN 等）会校验 Referer 而拒绝。
      // 自动改用页面内播放器：那边带的是页面自己的来源，能正常加载。
      fallbackToPagePreview(item, isVideo);
    });
    player.addEventListener("ended", () => {
      if (state.player !== player) return;
      stopPreview();
      render();
    });

    els.previewKind.textContent = isVideo ? "视频" : "音频";
    els.previewTitle.textContent = deriveTitle(item);
    els.previewBody.replaceChildren(player);
    els.preview.hidden = false;

    state.player = player;
    state.playingUrl = item.url;
    setStatus(isVideo ? "正在预览视频…" : "正在试听…");
    render();

    const started = player.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        // 加载失败时 error 回调已经接管（切到页面内播放器）；
        // 只有「元素还在、确实只是自动播放被拦」才提示手动点。
        if (state.player !== player) return;
        setStatus("预览已加载，点播放器上的播放键开始。");
      });
    }
  }

  /**
   * 在页面世界执行：往页面右下角挂一个播放器。
   * 页面自身的来源 / Cookie / Referer 都正确，能播放弹窗里放不了的地址。
   */
  function showInPagePlayer(url, isVideo, title) {
    const HOST_ID = "__media_downloader_player";
    const previous = document.getElementById(HOST_ID);
    if (previous) previous.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;" +
      "width:min(420px,calc(100vw - 32px));background:#202124;border:1px solid #3a3d42;" +
      "border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);overflow:hidden;" +
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#f1f2f4";

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#26282c;border-bottom:1px solid #3a3d42";

    const label = document.createElement("span");
    label.textContent = title || "页面内预览";
    label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#c6cbd2";
    label.title = title || "";

    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "关闭预览";
    close.style.cssText = "width:24px;height:24px;border:1px solid #4a4e55;border-radius:6px;" +
      "background:#292c30;color:#d7dce2;font-size:14px;line-height:1;cursor:pointer;padding:0";
    close.addEventListener("click", () => host.remove());

    const media = document.createElement(isVideo ? "video" : "audio");
    media.controls = true;
    media.autoplay = true;
    media.src = url;
    media.style.cssText = isVideo
      ? "display:block;width:100%;max-height:240px;background:#000"
      : "display:block;width:100%;height:44px";
    media.addEventListener("error", () => {
      label.textContent = "该地址在页面里也无法直接播放，请改用下载";
      label.style.color = "#ef6a6a";
    });

    bar.append(label, close);
    host.append(bar, media);
    (document.body || document.documentElement).append(host);

    const started = media.play();
    if (started && typeof started.catch === "function") started.catch(() => {});
    return true;
  }

  async function fallbackToPagePreview(item, isVideo) {
    setStatus("弹窗里放不了（站点校验了来源），正在改用页面内预览…", "busy");
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: state.tabId, frameIds: [typeof item.frameId === "number" ? item.frameId : 0] },
        world: "MAIN",
        func: showInPagePlayer,
        args: [item.url, isVideo, deriveTitle(item)]
      });
      if (injected && injected[0] && injected[0].result) {
        setStatus("已在页面右下角打开播放器（用页面自身身份加载，不受来源校验影响）。");
      } else {
        throw new Error("页面拒绝注入播放器。");
      }
    } catch (error) {
      setStatus("该地址无法直接播放，请点「下载」保存后再看。", "error");
    }
  }

  function togglePreview(item) {
    if (state.playingUrl === item.url) {
      stopPreview();
      render();
      setStatus("已停止预览。");
      return;
    }
    startPreview(item);
  }

  /* ---------------------------------------------------------------- 复制 */

  async function copyText(text, label) {
    const name = label || "内容";
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`${name}已复制到剪贴板。`);
      return;
    } catch (error) {
      // 剪贴板 API 在部分环境下不可用，退回旧方案。
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      setStatus(`${name}已复制到剪贴板。`);
    } catch (error) {
      setStatus("复制失败，请手动复制。", "error");
    }
    textarea.remove();
  }

  function copyUrl(url) {
    return copyText(url, "地址");
  }

  /* ---------------------------------------------------------------- 生命周期 */

  async function load() {
    if (state.tabId == null) return;
    try {
      const response = await chrome.runtime.sendMessage({ cmd: "get", tabId: state.tabId });
      state.items = (response && response.items) || [];
      if (response && response.pageUrl) state.pageUrl = response.pageUrl;
      if (response && response.pageTitle && !state.pageTitle) state.pageTitle = response.pageTitle;
      render();
      const visible = allVisible();
      if (visible.length) {
        setStatus(`已检测到 ${visible.length} 个资源，点「下载」保存。`);
      } else {
        setStatus("暂未检测到资源，先在页面上点一下播放。");
      }
    } catch (error) {
      showEmpty("无法读取扩展后台", "请到 chrome://extensions 重新加载本扩展后再试。");
      setStatus("后台不可用", "error");
    }
  }

  /* ------------------------------------------------------- 平台增强（可选） */

  function renderMeta() {
    const meta = state.platformMeta;
    const caption = meta ? String(meta.caption || "").trim() : "";
    const author = meta ? String(meta.author || "").trim() : "";
    const workId = meta ? String(meta.workId || "").trim() : "";
    const title = meta ? String(meta.title || "").trim() : "";
    // 作者、作品 ID、文案都没有，就别占地方了（比如抖音首页这种没有具体作品的地方）。
    if (!caption && !author && !workId) {
      els.meta.hidden = true;
      return;
    }
    els.meta.hidden = false;
    els.metaPlatform.textContent = state.platform ? state.platform.label : "页面";
    els.metaAuthor.textContent = [author, workId ? `作品 ${workId}` : ""].filter(Boolean).join(" · ") || title;
    const body = caption || title;
    els.metaCaption.textContent = body;
    els.metaCaption.hidden = !body;
    els.metaCopy.disabled = !body;
  }

  /**
   * 命中平台适配器时，额外去页面里读作者 / 标题 / 文案。
   * 任何一步失败都只是「没有增强」，不影响通用嗅探出来的列表。
   */
  async function loadPlatformMeta() {
    state.platform = (globalThis.Platforms && globalThis.Platforms.find(state.pageUrl)) || null;
    state.platformMeta = null;
    if (!state.platform) {
      renderMeta();
      return;
    }

    let meta = null;
    if (typeof state.platform.extract === "function") {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId: state.tabId, frameIds: [0] },
          world: "MAIN",
          func: state.platform.extract
        });
        meta = (injected && injected[0] && injected[0].result) || null;
      } catch (error) {
        meta = null;
      }
    }

    // 有些平台（网易云、QQ 音乐）把歌名歌手直接写在 <title> 里，不必注入页面。
    if (typeof state.platform.fromTitle === "function") {
      const fromTitle = state.platform.fromTitle(state.pageTitle || "");
      if (fromTitle) {
        meta = meta || {};
        for (const key of ["title", "author", "caption"]) {
          if (!meta[key] && fromTitle[key]) meta[key] = fromTitle[key];
        }
      }
    }

    if (meta && (meta.title || meta.author || meta.caption)) state.platformMeta = meta;
    renderMeta();
  }

  async function reloadAll() {
    await load();
    await loadPlatformMeta();
    render();
  }

  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (!state.busy && !state.pending) load();
    }, 400);
  }

  if (HAS_CHROME) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "media-updated" && message.tabId === state.tabId) scheduleReload();
      return false;
    });
  }

  els.refresh.addEventListener("click", () => {
    els.refresh.disabled = true;
    setStatus("正在重新检测当前页面…", "busy");
    reloadAll().finally(() => { els.refresh.disabled = false; });
  });

  els.metaCopy.addEventListener("click", () => {
    const meta = state.platformMeta;
    const caption = meta ? String(meta.caption || meta.title || "").trim() : "";
    if (caption) copyText(caption, "文案");
  });

  els.clear.addEventListener("click", async () => {
    stopPreview();
    await chrome.runtime.sendMessage({ cmd: "clear", tabId: state.tabId });
    state.items = [];
    render();
    setStatus("列表已清空。");
  });

  els.previewClose.addEventListener("click", () => {
    stopPreview();
    render();
    setStatus("已停止预览。");
  });

  els.previewOpen.addEventListener("click", () => {
    if (!HAS_CHROME) return;
    const current = state.items.find((item) => item.url === state.playingUrl);
    if (!current) return;
    chrome.tabs.create({ url: current.url, active: true }).catch(() => {});
    setStatus("已在新标签页打开，可用浏览器自带播放器查看。");
  });

  els.downloadAll.addEventListener("click", () => {
    if (!state.busy) downloadAll();
  });

  els.filters.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter || "all";
    for (const node of els.filters.querySelectorAll(".chip")) {
      node.classList.toggle("is-active", node === chip);
    }
    render();
  });

  els.askSave.addEventListener("change", () => {
    state.askSave = els.askSave.checked;
    chrome.storage.local.set({ askSave: state.askSave }).catch(() => {});
  });

  els.showSegments.addEventListener("change", () => {
    state.showSegments = els.showSegments.checked;
    chrome.storage.local.set({ showSegments: state.showSegments }).catch(() => {});
    render();
  });

  async function init() {
    if (!HAS_CHROME) {
      els.subtitle.textContent = "未在扩展环境中运行";
      showEmpty("请从扩展图标打开", "直接打开 popup.html 只能看样式；实际嗅探需要在 Chrome 里加载本扩展后点击工具栏图标。");
      setStatus("未检测到扩展环境", "error");
      return;
    }
    try {
      const stored = await chrome.storage.local.get({ askSave: false, showSegments: false });
      state.askSave = Boolean(stored.askSave);
      state.showSegments = Boolean(stored.showSegments);
      els.askSave.checked = state.askSave;
      els.showSegments.checked = state.showSegments;
    } catch (error) {
      // 默认值即可。
    }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) {
      showEmpty("没有找到当前标签页", "请打开一个网页后再点插件图标。");
      setStatus("无法读取当前标签页", "error");
      return;
    }
    state.tabId = tab.id;
    state.pageUrl = tab.url || "";
    state.pageTitle = tab.title || "";
    state.platform = (globalThis.Platforms && globalThis.Platforms.find(state.pageUrl)) || null;
    els.subtitle.textContent = state.platform
      ? `${state.platform.label} · ${MT.hostLabel(tab.url)}`
      : (MT.hostLabel(tab.url) || "当前页面");
    if (!/^https?:/i.test(state.pageUrl)) {
      showEmpty("当前页面无法嗅探", "chrome:// 等内部页面不允许扩展读取，请切换到普通网页。");
      setStatus("仅支持普通网页");
      return;
    }
    await reloadAll();
  }

  init();
})();
