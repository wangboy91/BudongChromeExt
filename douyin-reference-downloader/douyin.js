/** Self-contained page functions; copied into each independently loadable extension. */
(function (root) {
  function collect() {
    const pageUrl = location.href;
    const result = { pageUrl, videoCount: 0, blobCount: 0, media: [], streams: [], author: "", title: "", caption: "", workId: "", cover: "" };
    if (location.hostname !== "douyin.com" && !location.hostname.endsWith(".douyin.com")) return result;
    const page = new URL(pageUrl);
    let workId = page.pathname.match(/\/(?:video|jingxuan)\/(\d+)/)?.[1] || page.searchParams.get("modal_id") || "";
    if (!/^\d+$/.test(workId)) workId = "";
    const videos = [...document.querySelectorAll("video")].sort((a, b) => {
      const score = (v) => {
        const r = v.getBoundingClientRect();
        return Number(!v.paused) * 1e9 + Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      };
      return score(b) - score(a);
    });
    result.videoCount = videos.length;
    result.blobCount = videos.filter((v) => (v.currentSrc || v.src).startsWith("blob:")).length;
    const video = videos[0];
    if (!workId && video) {
      workId = video.closest("[data-e2e-vid]")?.getAttribute("data-e2e-vid") || "";
      try { workId ||= new URL(video.currentSrc || video.src).searchParams.get("__vid") || ""; } catch { /* blob */ }
    }
    result.workId = workId;
    if (!video && !workId) return result;
    const urls = (value) => {
      if (typeof value === "string") {
        try {
          const u = new URL(value, pageUrl);
          return u.protocol === "https:" ? [u.href] : [];
        } catch { return []; }
      }
      if (Array.isArray(value)) return value.flatMap(urls);
      if (!value || typeof value !== "object") return [];
      return urls(value.src || value.url_list || value.urlList || value.url);
    };
    const find = (seeds) => {
      const queue = [...seeds];
      const seen = new Set();
      for (let i = 0; i < queue.length && i < 12000; i += 1) {
        const value = queue[i];
        if (!value || typeof value !== "object" || seen.has(value) || value instanceof Node) continue;
        seen.add(value);
        const id = String(value.awemeId || value.aweme_id || "");
        if (value.video && /^\d+$/.test(id) && (workId ? id === workId : true)) {
          workId ||= id;
          return value;
        }
        for (const [key, next] of Object.entries(value)) {
          // React back-links can pull in unrelated works and the entire DOM.
          if (!/^(return|child|sibling|alternate|stateNode|_owner)$/.test(key) && next && typeof next === "object") queue.push(next);
        }
      }
      return null;
    };
    let detail = null;
    // Current player props are fresher than initial HTML after an SPA transition.
    const holders = [workId ? document.querySelector(`[data-e2e-vid="${workId}"]`) : null, video];
    for (let holder of holders) {
      while (holder && !detail) {
        const key = Object.getOwnPropertyNames(holder).find((name) => name.startsWith("__reactFiber"));
        let fiber = key ? holder[key] : null;
        for (let level = 0; fiber && level < 25 && !detail; level += 1, fiber = fiber.return) {
          detail = find([fiber.memoizedProps, fiber.memoizedState]);
        }
        if (key) break;
        holder = holder.parentElement;
      }
      if (detail) break;
    }
    result.detailSource = detail ? "current-player" : "none";
    if (!detail) {
      try {
        const text = document.getElementById("RENDER_DATA")?.textContent;
        detail = text ? find([JSON.parse(decodeURIComponent(text))]) : null;
        if (detail) result.detailSource = "current-page";
      } catch { /* Fall back to the current media element. */ }
    }
    result.workId = workId;
    result.title = detail?.itemTitle || detail?.desc?.split("\n")[0] || document.title.replace(/\s*[-–|]\s*抖音.*$/u, "").trim();
    result.caption = detail?.desc || detail?.itemTitle || "";
    result.author = detail?.author?.nickname || detail?.author?.nick_name || detail?.authorInfo?.nickname || "";
    result.cover = urls(detail?.video?.cover)[0] || video?.poster || "";
    const data = detail?.video;
    const rates = data?.bitRateList || data?.bit_rate || [];
    const versions = rates.length ? rates : data ? [data] : [];
    const best = new Map();
    for (const version of versions) {
      const format = version.format || version.videoFormat || version.video_format;
      if (format && format !== "mp4") continue;
      const addresses = [...new Set(urls(version.playAddr || version.play_addr))];
      if (!addresses.length) continue;
      const width = version.width || data.width || null;
      const height = version.height || data.height || null;
      const codec = version.isH265 || version.is_h265 ? "HEVC" : "H.264";
      const bytes = version.dataSize || version.data_size || null;
      const key = `${width}x${height}-${codec}`;
      if (best.has(key) && best.get(key).bytes >= bytes) continue;
      best.set(key, { url: addresses[0], urls: addresses, width, height, codec, bytes, duration: data.duration / 1000 || null });
    }
    if (!best.size && video) {
      const addresses = [...new Set(urls([video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map((s) => s.src)]))];
      if (addresses.length) best.set("current", { url: addresses[0], urls: addresses, width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : null });
    }
    result.streams = [...best.values()]
      .sort((a, b) => Number(a.codec === "HEVC") - Number(b.codec === "HEVC") || b.height - a.height || b.bytes - a.bytes)
      .slice(0, 6).map((item) => ({ ...item, title: result.title, author: result.author, poster: result.cover, workId, kind: "video", ext: "mp4", mime: "video/mp4", size: item.bytes, source: "douyin", pageDownload: true, resolvedNote: [item.width && item.height ? `${item.width} × ${item.height}` : "", item.codec].filter(Boolean).join(" · ") }));
    result.media = result.streams;
    result.detailId = detail ? workId : "";
    return result;
  }

  async function download(item, filename) {
    if (location.hostname !== "douyin.com" && !location.hostname.endsWith(".douyin.com")) return { error: "请回到抖音作品页重新检测。" };
    const page = new URL(location.href);
    const currentId = page.pathname.match(/\/(?:video|jingxuan)\/(\d+)/)?.[1] || page.searchParams.get("modal_id");
    if (item.workId && currentId && item.workId !== currentId) return { error: "当前作品已切换，请重新检测后下载。" };
    const post = (payload) => window.postMessage({ __mediaDownloaderProgress: payload }, "*");
    post({ phase: "start", total: 0 });
    let lastError = "没有可用的视频地址";
    for (const url of [...new Set([item.url, ...(item.urls || [])])]) {
      try {
        if (new URL(url).protocol !== "https:") continue;
        const response = await fetch(url, { headers: { Range: "bytes=0-" }, referrerPolicy: "strict-origin-when-cross-origin", cache: "no-store", signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const range = response.headers.get("content-range") || "";
        const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (response.status === 206 && (!match || Number(match[1]) !== 0 || Number(match[2]) + 1 !== Number(match[3]))) throw new Error("服务器只返回了部分视频，请重新检测");
        const expected = match ? Number(match[3]) : Number(response.headers.get("content-length")) || 0;
        const chunks = [];
        let received = 0;
        let lastReport = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          if (Date.now() - lastReport > 400) {
            lastReport = Date.now();
            post({ phase: "progress", received, total: expected });
          }
        }
        if (!received || (expected && received !== expected)) throw new Error("视频数据不完整，请重新下载");
        const blob = new Blob(chunks, { type: "video/mp4" });
        const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        if (String.fromCharCode(...head.slice(4, 8)) !== "ftyp") throw new Error("服务器返回的不是 MP4 视频，请重新检测");
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 600000);
        post({ phase: "done", received, total: received });
        return { size: received };
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    const error = `下载失败（${lastError}），请播放当前视频并重新检测后重试。`;
    post({ phase: "error", message: error });
    return { error };
  }

  root.DouyinMedia = Object.freeze({ collect, download });
})(globalThis);
