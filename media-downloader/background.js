/**
 * 后台 service worker：网络嗅探 + 按标签页汇总媒体列表。
 *
 * 三条数据来源：
 *  1. webRequest.onBeforeRequest —— 按 URL 后缀先认一遍（快，覆盖直链）
 *  2. webRequest.onHeadersReceived —— 按 content-type / content-disposition / 请求类型
 *     精确判定（覆盖签名直链这种没有后缀的地址）
 *  3. 内容脚本上报 —— DOM 里的 <audio>/<video> 以及 blob: 地址（网络层看不到）
 */
importScripts("media-types.js");

const { describe } = MediaTypes;

const MAX_ITEMS_PER_TAB = 400;
const REQUEST_TYPES = ["media", "xmlhttprequest", "object", "other", "main_frame", "sub_frame"];

/** @type {Map<number, Map<string, object>>} tabId -> (url -> item) */
const tabMedia = new Map();
/** @type {Map<number, {url:string, title:string}>} */
const tabMeta = new Map();
/** 需要隐藏的分片后缀：HLS/DASH 会把一个音频拆成几百个片段。 */
const SEGMENT_EXT = new Set(["ts", "m4s", "m4v", "cmfv", "cmfa", "vtt", "aac", "mp4", "m4a"]);

/* ------------------------------------------------------------------ 存储 */

/** 本次会话里被改动过的标签页，写盘时只覆盖这些，避免抹掉未加载的其他标签页。 */
const dirtyTabs = new Set();
const removedTabs = new Set();

function getMap(tabId) {
  let map = tabMedia.get(tabId);
  if (!map) {
    map = new Map();
    tabMedia.set(tabId, map);
  }
  return map;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, 800);
}

async function flushSave() {
  const dirty = [...dirtyTabs];
  const removed = [...removedTabs];
  dirtyTabs.clear();
  removedTabs.clear();
  if (!dirty.length && !removed.length) return;
  try {
    const stored = await chrome.storage.session.get("tabMedia");
    const payload = (stored && stored.tabMedia) || {};
    for (const tabId of dirty) {
      const map = tabMedia.get(tabId);
      if (map) payload[String(tabId)] = [...map.values()];
      else delete payload[String(tabId)];
    }
    for (const tabId of removed) delete payload[String(tabId)];
    await chrome.storage.session.set({ tabMedia: payload });
  } catch (error) {
    // 会话存储不可用时退化为纯内存，不影响嗅探。
  }
}

/** service worker 会被回收，冷启动时把会话缓存读回来。 */
async function hydrate(tabId) {
  if (tabMedia.has(tabId)) return;
  try {
    const stored = await chrome.storage.session.get("tabMedia");
    const payload = stored && stored.tabMedia;
    if (!payload) return;
    const items = payload[String(tabId)];
    if (Array.isArray(items) && !tabMedia.has(tabId)) {
      tabMedia.set(tabId, new Map(items.map((item) => [item.url, item])));
    }
  } catch (error) {
    // 忽略。
  }
}

/* ------------------------------------------------------------------ 判定 */

function stripUndefined(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function upsert(tabId, patch) {
  if (tabId == null || tabId < 0) return;
  const url = patch.url;
  if (!url) return;
  const map = getMap(tabId);
  const previous = map.get(url) || { url, ts: Date.now() };
  const next = { ...previous, ...stripUndefined(patch), id: url };
  const meta = tabMeta.get(tabId);
  if (meta) {
    next.pageUrl = next.pageUrl || meta.url;
    next.pageTitle = next.pageTitle || meta.title;
  }
  // 同一条地址被多次命中时，保留更高置信度的判定。
  if (previous.kind && patch.confidence && patch.confidence < (previous.confidence || 0)) {
    next.kind = previous.kind;
    next.ext = patch.ext || previous.ext;
  }
  map.set(url, next);
  markSegments(tabId);
  trim(tabId);
  updateBadge(tabId);
  dirtyTabs.add(tabId);
  scheduleSave();
  notifyPopup(tabId);
}

function trim(tabId) {
  const map = tabMedia.get(tabId);
  if (!map || map.size <= MAX_ITEMS_PER_TAB) return;
  const ordered = [...map.values()].sort((a, b) => a.ts - b.ts);
  for (const item of ordered.slice(0, map.size - MAX_ITEMS_PER_TAB)) map.delete(item.url);
}

/**
 * 把 HLS/DASH 的分片标成 hidden。
 * 判定依据：同标签页里出现过播放列表，且该资源的目录与播放列表同源同目录，
 * 后缀又是典型分片格式。用户仍可在弹窗里用「显示分片」看到它们。
 */
function markSegments(tabId) {
  const map = tabMedia.get(tabId);
  if (!map) return;
  const dirs = [];
  for (const item of map.values()) {
    if (item.kind === "hls" || item.kind === "dash") dirs.push(item.url.replace(/[^/]*$/, ""));
  }
  for (const item of map.values()) {
    if (item.kind === "hls" || item.kind === "dash") {
      item.hidden = false;
      continue;
    }
    const segmentExt = SEGMENT_EXT.has(item.ext) || item.mime === "video/mp2t" || item.mime === "video/iso.segment";
    const sameDir = dirs.some((dir) => dir && item.url.startsWith(dir));
    item.hidden = Boolean(segmentExt && sameDir && item.requestType !== "main_frame");
  }
}

/** 可见条目数量，用于判断角标和弹窗是否需要刷新（HLS 分片会疯狂触发 upsert）。 */
const lastBadgeCount = new Map();
const notifyTimers = new Map();

function visibleCount(tabId) {
  const map = tabMedia.get(tabId);
  let count = 0;
  if (map) {
    for (const item of map.values()) if (!item.hidden) count += 1;
  }
  return count;
}

function updateBadge(tabId) {
  const count = visibleCount(tabId);
  if (lastBadgeCount.get(tabId) === count) return;
  lastBadgeCount.set(tabId, count);
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#4eabed" }).catch(() => {});
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ tabId, color: "#0b2233" }).catch(() => {});
  }
}

/** 尾沿节流：连续 upsert 时最多每 400ms 通知弹窗一次。 */
function notifyPopup(tabId) {
  if (notifyTimers.has(tabId)) return;
  notifyTimers.set(tabId, setTimeout(() => {
    notifyTimers.delete(tabId);
    chrome.runtime.sendMessage({ type: "media-updated", tabId }).catch(() => {});
  }, 400));
}

/* ------------------------------------------------------- webRequest 监听 */

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const found = headers.find((header) => header.name.toLowerCase() === name);
  return found ? String(found.value || "") : "";
}

function parseSize(headers) {
  const range = headerValue(headers, "content-range");
  const total = range.match(/\/(\d+)\s*$/);
  if (total) return { size: Number(total[1]), partial: true };
  const length = Number(headerValue(headers, "content-length"));
  if (Number.isFinite(length) && length > 0) return { size: length, partial: false };
  return { size: null, partial: false };
}

function onRequest(details) {
  if (details.tabId < 0) return;
  const info = describe({ url: details.url, requestType: details.type });
  if (!info) return;
  upsert(details.tabId, {
    url: details.url,
    kind: info.kind,
    ext: info.ext,
    mime: info.mime,
    confidence: info.confidence,
    source: "network",
    requestType: details.type
  });
}

function onResponse(details) {
  if (details.tabId < 0) return;
  const headers = details.responseHeaders;
  const mime = headerValue(headers, "content-type");
  const disposition = headerValue(headers, "content-disposition");
  const info = describe({ url: details.url, mime, disposition, requestType: details.type });
  if (!info) {
    // 地址看着像媒体，服务端却回了 HTML（404 页面之类），把它撤掉。
    if (MediaTypes.normalizeMime(mime) === "text/html") removeUrl(details.tabId, details.url);
    return;
  }
  const { size, partial } = parseSize(headers);
  const named = MediaTypes.filenameFromDisposition(disposition);
  upsert(details.tabId, {
    url: details.url,
    kind: info.kind,
    ext: info.ext || MediaTypes.extFromUrl(named) || "",
    mime: info.mime || mime,
    size,
    partial,
    confidence: info.confidence,
    fileName: named || undefined,
    source: "network",
    requestType: details.type
  });
}

function removeUrl(tabId, url) {
  const map = tabMedia.get(tabId);
  if (!map || !map.has(url)) return;
  map.delete(url);
  updateBadge(tabId);
  dirtyTabs.add(tabId);
  scheduleSave();
  notifyPopup(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(onRequest, {
  urls: ["<all_urls>"],
  types: REQUEST_TYPES
});

chrome.webRequest.onHeadersReceived.addListener(
  onResponse,
  { urls: ["<all_urls>"], types: REQUEST_TYPES },
  ["responseHeaders"]
);

/* ------------------------------------------------------------ 标签页生命周期 */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.url) {
    tabMeta.set(tabId, { url: tab.url || "", title: tab.title || "" });
  }
  // 整页导航（status=loading）时清空旧列表；SPA 的 pushState 不会带 loading。
  if (changeInfo.status === "loading") {
    tabMedia.delete(tabId);
    updateBadge(tabId);
    dirtyTabs.add(tabId);
    scheduleSave();
    notifyPopup(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  tabMeta.delete(tabId);
  lastBadgeCount.delete(tabId);
  if (notifyTimers.has(tabId)) {
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.delete(tabId);
  }
  dirtyTabs.delete(tabId);
  removedTabs.add(tabId);
  scheduleSave();
});

/* ---------------------------------------------------------------- 消息路由 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message && message.tabId != null ? message.tabId : sender.tab && sender.tab.id;

  if (message && message.cmd === "get") {
    hydrate(tabId).then(() => {
      const map = tabMedia.get(tabId);
      const items = map ? [...map.values()] : [];
      const meta = tabMeta.get(tabId) || {};
      sendResponse({ items, pageUrl: meta.url || "", pageTitle: meta.title || "" });
    });
    return true;
  }

  if (message && message.cmd === "clear") {
    tabMedia.delete(tabId);
    updateBadge(tabId);
    dirtyTabs.add(tabId);
    scheduleSave();
    sendResponse({ ok: true });
    return false;
  }

  // 内容脚本上报 DOM / blob 资源。
  if (message && (message.cmd === "dom" || message.cmd === "blob")) {
    if (tabId != null && tabId >= 0) {
      const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
      for (const item of message.items || []) {
        if (typeof item.url !== "string") continue;
        const isBlob = item.url.startsWith("blob:");
        const info = describe({ url: item.url, mime: item.mime });
        upsert(tabId, {
          url: item.url,
          kind: item.kind || (info && info.kind) || "audio",
          ext: item.ext || (info && info.ext) || "",
          mime: item.mime || (info && info.mime) || "",
          duration: item.duration,
          title: item.title,
          poster: item.poster,
          frameId,
          confidence: isBlob ? 1 : (info ? info.confidence : 1),
          source: isBlob ? "blob" : "dom",
          requestType: isBlob ? "blob" : "media"
        });
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// 打开弹窗时顺手记下当前标签页信息，便于给条目补标题。
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => {
    tabMeta.set(tabId, { url: tab.url || "", title: tab.title || "" });
  }).catch(() => {});
});
