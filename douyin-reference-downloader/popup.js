const list = document.getElementById("list");
const count = document.getElementById("count");
const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

function videoId(pageUrl) {
  const url = new URL(pageUrl);
  const match = url.pathname.match(/\/(?:video|jingxuan)\/(\d+)/);
  return match?.[1] || url.searchParams.get("modal_id")?.match(/^\d+$/)?.[0] || null;
}

// Keep the transfer in the page so Douyin receives the correct Referer.
async function downloadMedia(tabId, item, filename) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: DouyinMedia.download,
    args: [item, filename]
  });
  const result = injected[0]?.result;
  if (!result) throw new Error("页面没有返回下载结果，请刷新页面后重试。");
  if (result.error) throw new Error(result.error);
  return result.size;
}

function isDouyinPage(url) {
  try {
    const page = new URL(url);
    return page.protocol === "https:" && (page.hostname === "douyin.com" || page.hostname.endsWith(".douyin.com"));
  } catch {
    return false;
  }
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

function textNode(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function showEmpty(title, detail) {
  list.replaceChildren();
  const empty = textNode("div", "empty", "");
  empty.append(textNode("strong", "", title), textNode("p", "", detail));
  list.append(empty);
  count.textContent = "0";
}

function safeFilename(title, id, item) {
  const clean = (value, limit) => String(value || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  const author = clean(item.author, 32);
  const base = clean(title, 72) || "抖音视频";
  const name = author && !base.startsWith(`${author}-`) ? `${author}-${base}` : base;
  const version = item.width && item.height
    ? `-${item.width}x${item.height}-${item.codec === "HEVC" ? "HEVC" : "H264"}`
    : "";
  return `${name}-${id || "参考"}${version}.mp4`;
}

function qualityLabel(item) {
  const resolution = item.width && item.height ? `${item.width} × ${item.height}` : "原始画质";
  const codec = item.codec ? ` · ${item.codec}` : "";
  const size = item.bytes ? ` · 约 ${(item.bytes / 1000000).toFixed(1)} MB` : "";
  return `${resolution}${codec}${size}`;
}

function makeCard(versions, id, tabId) {
  const item = versions[0];
  const card = textNode("article", "card", "");
  const thumb = textNode("div", "thumb", "");
  if (item.poster?.startsWith("https://")) {
    const image = document.createElement("img");
    image.src = item.poster;
    image.alt = "视频封面";
    image.addEventListener("error", () => image.replaceWith(textNode("div", "thumb-placeholder", "▶")), { once: true });
    thumb.append(image);
  } else {
    thumb.append(textNode("div", "thumb-placeholder", "▶"));
  }
  const time = durationLabel(item.duration);
  if (time) thumb.append(textNode("span", "duration", time));

  const body = textNode("div", "card-body", "");
  const title = textNode("div", "name", "");
  const meta = textNode("div", "meta", "");
  function updateMeta(chosen) {
    title.textContent = safeFilename(chosen.title, id, chosen);
    meta.replaceChildren(textNode("span", "badge", "MP4"), textNode("span", "", qualityLabel(chosen)));
  }
  updateMeta(item);

  const actions = textNode("div", "actions", "");
  const quality = document.createElement("select");
  quality.className = "quality-select";
  quality.setAttribute("aria-label", "选择清晰度和编码");
  versions.forEach((version, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = qualityLabel(version);
    quality.append(option);
  });
  const download = textNode("button", "download", "↓  下载");
  download.type = "button";
  download.setAttribute("aria-label", "下载当前选择的版本");
  quality.addEventListener("change", () => {
    updateMeta(versions[Number(quality.value)]);
    download.disabled = false;
    download.textContent = "↓  下载";
  });
  download.addEventListener("click", async () => {
    const chosen = versions[Number(quality.value)];
    download.disabled = true;
    download.textContent = "下载中…";
    status.textContent = `正在取回 ${qualityLabel(chosen)} 版本，请保持抖音页面打开…`;
    try {
      const bytes = await downloadMedia(tabId, chosen, safeFilename(chosen.title || "抖音视频", id, chosen));
      status.textContent = `视频已取回（${(bytes / 1000000).toFixed(1)} MB），已交给浏览器保存。`;
      download.textContent = "✓  已提交";
    } catch (error) {
      status.textContent = error?.message || "下载失败，请重试。";
      download.textContent = "重试下载";
      download.disabled = false;
    }
  });
  actions.append(quality, download);
  body.append(title, meta, actions);
  card.append(thumb, body);
  return card;
}

async function scan() {
  refresh.disabled = true;
  status.textContent = "正在检测当前页面…";
  showEmpty("正在查找视频", "请稍候。");
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("没有找到当前标签页。");
    let result = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: DouyinMedia.collect });
      result = injected[0]?.result;
      if (!isDouyinPage(result?.pageUrl) || result?.media?.length) break;
      if (attempt < 2) {
        status.textContent = "页面还在加载，正在重新检测…";
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    const pageUrl = result?.pageUrl || tab.url;
    if (!isDouyinPage(pageUrl)) {
      const host = pageUrl ? new URL(pageUrl).hostname : "当前标签页";
      showEmpty("当前不是抖音视频页", `现在打开的是 ${host}。请切回要下载的抖音视频标签页，再点插件图标。`);
      status.textContent = "仅检测当前抖音标签页";
      return;
    }
    const media = result?.media || [];
    if (!media.length) {
      showEmpty(
        "还没有找到可下载的视频",
        "请打开具体作品并播放几秒，再点重新检测。"
      );
      status.textContent = `已连接 ${new URL(pageUrl).hostname}，但未读到可下载的 HTTPS 视频地址`;
      return;
    }
    const id = result.workId || videoId(pageUrl);
    list.replaceChildren(makeCard(media, id, tab.id));
    count.textContent = "1";
    status.textContent = `已检测到 1 个视频 · 可选 ${media.length} 种版本`;
  } catch (error) {
    showEmpty("检测失败", error?.message || "请刷新抖音页面，再试一次。");
    status.textContent = "请重试";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", scan);
scan();
