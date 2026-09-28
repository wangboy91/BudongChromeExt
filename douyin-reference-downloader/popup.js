const list = document.getElementById("list");
const count = document.getElementById("count");
const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

function videoId(pageUrl) {
  const url = new URL(pageUrl);
  const match = url.pathname.match(/\/video\/(\d+)/);
  return match?.[1] || url.searchParams.get("modal_id")?.match(/^\d+$/)?.[0] || null;
}

// Runs inside the active tab. It reads media exposed by the page's video elements.
async function collectPageMedia() {
  const pageUrl = location.href;
  if (location.hostname !== "douyin.com" && !location.hostname.endsWith(".douyin.com")) {
    return { pageUrl, videoCount: 0, blobCount: 0, media: [] };
  }
  const fallbackPoster = document.querySelector('meta[property="og:image"]')?.content || "";
  const pageTitle = document.title.replace(/\s*[-–|].*抖音.*$/u, "").trim() || "抖音视频";
  const seen = new Set();
  const media = [];
  const videos = [...document.querySelectorAll("video")];
  let blobCount = 0;

  // Douyin sometimes plays through a blob: URL. A profile modal can change
  // works without replacing RENDER_DATA, so request the current work page when
  // the embedded detail is stale.
  let detailSource = "none";
  let detailId = "";
  let detailAuthor = "";
  const apiDebug = [];
  try {
    const page = new URL(pageUrl);
    const workId = page.pathname.match(/\/video\/(\d+)/)?.[1] || page.searchParams.get("modal_id");
    const findDetail = (data) => {
      if (!data || !workId) return null;
      const root = data?.app?.videoDetail;
      if (String(root?.awemeId || root?.aweme_id || "") === workId) return root;
      // Search and Jingxuan pages may keep the opened work in a list rather
      // than app.videoDetail. Only accept metadata for the URL's exact work ID.
      const queue = [data];
      const visited = new Set();
      for (let index = 0; index < queue.length && index < 25000; index += 1) {
        const item = queue[index];
        if (!item || typeof item !== "object" || visited.has(item)) continue;
        visited.add(item);
        if (String(item.awemeId || item.aweme_id || "") === workId && item.video) return item;
        for (const value of Object.values(item)) {
          if (value && typeof value === "object") queue.push(value);
        }
      }
      return root || null;
    };
    const parseDetail = (encoded) => encoded ? findDetail(JSON.parse(decodeURIComponent(encoded))) : null;
    let detail = parseDetail(document.getElementById("RENDER_DATA")?.textContent);
    detailId = String(detail?.awemeId || detail?.aweme_id || "");
    detailSource = detailId === workId ? "current-page" : "stale-page";
    if (workId && detailId !== workId) {
      // Search modals load works through JSON requests after the initial HTML.
      // Replay only same-origin requests already made by this tab. The browser
      // keeps its own session; the extension never reads or stores cookies.
      const apiPaths = /\/aweme\/v\d+\/web\/(general\/search\/(?:stream|single)|aweme\/detail)\//;
      const requests = performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.origin === page.origin && apiPaths.test(parsed.pathname);
          } catch {
            return false;
          }
        });
      for (const apiUrl of [...new Set(requests)].slice(-6).reverse()) {
        try {
          const response = await fetch(apiUrl, {
            credentials: "same-origin",
            cache: "force-cache",
            signal: AbortSignal.timeout(4000)
          });
          if (!response.ok) {
            apiDebug.push(`HTTP ${response.status}`);
            continue;
          }
          const body = await response.json();
          const candidate = findDetail(body);
          apiDebug.push(`HTTP ${response.status} / ${body?.status_code ?? "?"} / ${JSON.stringify(body).includes(workId) ? "has-id" : "no-id"} / ${String(candidate?.awemeId || candidate?.aweme_id || "-") === workId ? "match" : "other"}`);
          if (String(candidate?.awemeId || candidate?.aweme_id || "") !== workId) continue;
          detail = candidate;
          detailId = workId;
          detailSource = "search-api";
          break;
        } catch {
          apiDebug.push("request-error");
          // One request can expire while the other loaded search results remain valid.
        }
      }
    }
    if (workId && detailId !== workId) {
      const urls = [...new Set([new URL(`/video/${workId}`, page.origin).href, pageUrl])];
      for (const detailUrl of urls) {
        try {
          const response = await fetch(detailUrl, {
            credentials: "same-origin",
            cache: "reload",
            signal: AbortSignal.timeout(5000)
          });
          if (!response.ok) {
            detailSource = `refresh-http-${response.status}`;
            continue;
          }
          const html = await response.text();
          const freshPage = new DOMParser().parseFromString(html, "text/html");
          detail = parseDetail(freshPage.getElementById("RENDER_DATA")?.textContent);
          detailId = String(detail?.awemeId || detail?.aweme_id || "");
          detailSource = detailId === workId ? "refreshed-page" : "refresh-mismatch";
          if (detailId === workId) break;
        } catch {
          detailSource = "refresh-error";
        }
      }
    }
    if (detailId === workId && detail?.video) {
      detailAuthor = detail.author?.nickname || detail.author?.nick_name || detail.authorInfo?.nickname || "";
      const videoData = detail.video;
      const rateList = videoData.bitRateList || videoData.bit_rate || [];
      const bestByVersion = new Map();
      const httpsUrl = (address) => {
        if (typeof address === "string") return address.startsWith("https://") ? address : null;
        if (Array.isArray(address)) return address.map(httpsUrl).find(Boolean) || null;
        if (!address || typeof address !== "object") return null;
        return httpsUrl(address?.src || address?.url_list || address?.urlList);
      };
      const versions = Array.isArray(rateList) && rateList.length ? rateList : [videoData];
      for (const version of versions) {
        const format = version.format || version.videoFormat || version.video_format;
        if (format && format !== "mp4") continue;
        const src = httpsUrl(version.playAddr || version.play_addr);
        if (!src) continue;
        const codec = version.isH265 || version.is_h265 ? "HEVC" : "H.264";
        const width = version.width || videoData.width || null;
        const height = version.height || videoData.height || null;
        const bytes = version.dataSize || version.data_size || null;
        const key = `${width}x${height}-${codec}`;
        const previous = bestByVersion.get(key);
        if (!previous || bytes > previous.bytes) bestByVersion.set(key, { src, codec, width, height, bytes });
      }
      const choices = [...bestByVersion.values()]
        .sort((a, b) => Number(a.codec === "HEVC") - Number(b.codec === "HEVC") || b.height - a.height || b.bytes - a.bytes)
        .slice(0, 6);
      for (const version of choices) {
        if (seen.has(version.src)) continue;
        seen.add(version.src);
        media.push({
          url: version.src,
          title: detail.itemTitle || detail.desc?.split("\n")[0] || pageTitle,
          author: detailAuthor,
          poster: httpsUrl(videoData.cover) || fallbackPoster,
          width: version.width || null,
          height: version.height || null,
          duration: videoData.duration ? videoData.duration / 1000 : null,
          bytes: version.bytes,
          codec: version.codec,
          playing: false
        });
      }
    }
  } catch {
    detailSource = "detail-error";
  }

  for (const video of videos) {
    const sources = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll("source"), (source) => source.src)];
    for (const src of sources) {
      if (src?.startsWith("blob:")) blobCount += 1;
      if (media.length) continue;
      if (!src || !src.startsWith("https://") || seen.has(src)) continue;
      seen.add(src);
      media.push({
        url: src,
        title: pageTitle,
        author: detailAuthor,
        poster: video.poster || fallbackPoster,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        playing: !video.paused
      });
    }
  }
  if (!media.some((item) => item.bytes)) media.sort((a, b) => Number(b.playing) - Number(a.playing));
  return { pageUrl, videoCount: videos.length, blobCount, detailSource, detailId, apiDebug, media: media.slice(0, 12) };
}

// Runs in the page world: the currently mounted search player keeps its work
// metadata in component state, which an isolated extension script cannot see.
function readCurrentPlayerMedia() {
  const page = new URL(location.href);
  const workId = page.pathname.match(/\/video\/(\d+)/)?.[1] || page.searchParams.get("modal_id");
  const root = workId ? document.querySelector(`[data-e2e-vid="${workId}"]`) : null;
  const reactKeys = root ? Object.getOwnPropertyNames(root).filter((key) => key.startsWith("__react")) : [];
  const key = reactKeys.find((name) => name.startsWith("__reactFiber"));
  let fiber = key ? root[key] : null;
  let levels = 0;
  let idMatches = 0;
  let videoMatches = 0;
  let sample = null;
  let media = [];
  const httpsUrl = (address) => {
    if (typeof address === "string") return address.startsWith("https://") ? address : null;
    if (Array.isArray(address)) return address.map(httpsUrl).find(Boolean) || null;
    if (!address || typeof address !== "object") return null;
    return httpsUrl(address.src || address.url_list || address.urlList || address.url);
  };
  while (fiber && levels < 25) {
    const queue = [fiber.memoizedProps, fiber.memoizedState];
    const seen = new Set();
    for (let i = 0; i < queue.length && i < 6000; i += 1) {
      const value = queue[i];
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (String(value.awemeId || value.aweme_id || "") === workId) {
        idMatches += 1;
        if (value.video) {
          videoMatches += 1;
          const video = value.video;
          const rateList = video.bitRateList || video.bit_rate || [];
          if (!sample) sample = { videoKeys: Object.keys(video).slice(0, 24), rateCount: rateList.length || 0 };
          const versions = Array.isArray(rateList) && rateList.length ? rateList : [video];
          const found = versions.flatMap((version) => {
            const format = version.format || version.videoFormat || version.video_format;
            if (format && format !== "mp4") return [];
            const src = httpsUrl(version.playAddr || version.play_addr);
            if (!src) return [];
            return [{
              url: src,
              title: value.itemTitle || value.desc?.split("\n")[0] || document.title,
              author: value.author?.nickname || value.author?.nick_name || value.authorInfo?.nickname || "",
              poster: httpsUrl(video.cover) || "",
              width: version.width || video.width || null,
              height: version.height || video.height || null,
              duration: video.duration ? video.duration / 1000 : null,
              bytes: version.dataSize || version.data_size || null,
              codec: version.isH265 || version.is_h265 ? "HEVC" : "H.264",
              playing: true
            }];
          });
          if (found.length > media.length) media = found;
        }
      }
      for (const next of Object.values(value)) if (next && typeof next === "object") queue.push(next);
    }
    fiber = fiber.return;
    levels += 1;
  }
  const unique = [...new Map(media.map((item) => [item.url, item])).values()]
    .sort((a, b) => Number(a.codec === "HEVC") - Number(b.codec === "HEVC") || b.height - a.height || b.bytes - a.bytes)
    .slice(0, 6);
  return { rootFound: !!root, reactKeys: reactKeys.length, levels, idMatches, videoMatches, sample, media: unique };
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

function makeCard(versions, id) {
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
    download.textContent = "提交中…";
    status.textContent = `正在交给 Chrome 下载 ${qualityLabel(chosen)} 版本…`;
    try {
      const downloadId = await chrome.downloads.download({
        url: chosen.url,
        filename: safeFilename(chosen.title || "抖音视频", id, chosen),
        saveAs: true,
        conflictAction: "uniquify"
      });
      if (typeof downloadId !== "number") throw new Error("Chrome 未开始下载。");
      status.textContent = "已打开 Chrome 保存窗口。保存后请确认文件包含声音。";
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
      const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageMedia });
      result = injected[0]?.result;
      if (isDouyinPage(result?.pageUrl) && !result?.media?.some((item) => item.author)) {
        try {
          const pageState = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: readCurrentPlayerMedia });
          const player = pageState[0]?.result;
          result.player = player;
          if (player?.media?.some((item) => item.author) || (!result.media.length && player?.media?.length)) {
            result.media = player.media;
            result.detailSource = "current-player";
          }
        } catch {
          // Keep any media already found when the page does not expose player state.
        }
      }
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
        `当前页面有 ${result?.videoCount ?? 0} 个视频播放器、${result?.blobCount ?? 0} 个临时视频地址。详情状态：${result?.detailSource || "未知"}；播放器状态：${JSON.stringify({ ...result?.player, media: undefined })}。`
      );
      status.textContent = `已连接 ${new URL(pageUrl).hostname}，但未读到可下载的 HTTPS 视频地址`;
      return;
    }
    const id = videoId(pageUrl);
    list.replaceChildren(makeCard(media, id));
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
