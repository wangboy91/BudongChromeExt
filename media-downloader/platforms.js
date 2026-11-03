/**
 * 平台适配表。
 *
 * 设计原则：**通用嗅探打底，平台只做增强**。
 * 任何一个站点都能被嗅探到（走 background.js + content.js 的通用逻辑），
 * 这里只负责给「认得出的平台」多做几件事：
 *   1. 从页面里读出元信息（作者 / 标题 / 文案），显示在弹窗里，可一键复制；
 *   2. 用元信息拼出更好读的文件名；
 *   3. 把嗅探到的地址改写成真正能下的地址（resolve）；
 *   4. 把平台自己的噪音条目从列表里藏掉（hideItem）。
 * 没有命中的站点、或者命中但没读到数据的站点，一律退回通用逻辑，不会报错。
 *
 * 钩子一览（除 extract 外都在弹窗环境执行，可以用 fetch）：
 *   match(host, pageUrl)    -> boolean   是否命中
 *   extract()               -> object    在页面世界执行，读元信息；**必须自包含**
 *   fromTitle(pageTitle)    -> object    从 <title> 里抠元信息，不必注入页面
 *   filename(ctx)           -> string    不含扩展名的基名
 *   canResolve(item)        -> boolean   这条要不要走 resolve（可选，默认全走）
 *   resolve(item)           -> object    异步，返回 { url, title?, suffix?, note? } 或 null
 *   hideItem(item)          -> boolean   是否从列表里隐藏（可选）
 *
 * extract() 会被 chrome.scripting.executeScript({ world: "MAIN" }) 注入页面执行，
 * 因此**必须自包含**：不能引用本文件里的任何外部变量或函数，辅助函数要写在内部。
 *
 * filename(ctx) 只需要返回**不含扩展名的基名**（或 null 表示交回通用命名），
 * 扩展名由弹窗统一补上，这样长标题被截断时不会把后缀切掉。
 */
(function (root) {
  const adapters = [];

  function register(adapter) {
    adapters.push(adapter);
  }

  /**
   * 按页面地址找适配器。
   * @param {string} pageUrl
   * @returns {object|null}
   */
  function find(pageUrl) {
    let host = "";
    try {
      host = new URL(pageUrl).hostname;
    } catch (error) {
      return null;
    }
    for (const adapter of adapters) {
      try {
        if (adapter.match(host, pageUrl)) return adapter;
      } catch (error) {
        // 单个适配器出错不影响其他适配器。
      }
    }
    return null;
  }

  function hostEndsWith(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  /* ------------------------------------------------------------ 抖音 */

  const douyinExtract = root.DouyinMedia.collect;

  register({
    id: "douyin",
    label: "抖音",
    match: (host) => hostEndsWith(host, "douyin.com"),
    extract: douyinExtract,
    filename: (ctx) => {
      const parts = [ctx.clean(ctx.meta.author, 32), ctx.clean(ctx.meta.title, 72), ctx.clean(ctx.meta.workId, 24)];
      const base = parts.filter(Boolean).join("-");
      const item = ctx.item;
      const version = item.width && item.height ? `-${item.width}x${item.height}-${item.codec === "HEVC" ? "HEVC" : "H264"}` : "";
      return base ? base + version : null;
    }
  });

  /* ------------------------------------------------------------ 哔哩哔哩 */

  function bilibiliExtract() {
    const result = { author: "", title: "", caption: "", workId: "", cover: "" };
    const state = window.__INITIAL_STATE__;
    const info = state && (state.videoInfo || state);
    const video = (info && info.videoData) || (state && state.videoData) || null;
    if (video) {
      result.title = String(video.title || "").trim();
      result.caption = String(video.desc || "").trim();
      result.cover = String(video.pic || "").trim();
      result.workId = String(video.bvid || video.aid || "").trim();
    }
    const up = (info && info.upData) || (state && state.upData) || null;
    if (up) result.author = String(up.name || "").trim();
    if (!result.author) {
      const node = document.querySelector(".up-name, .up-info--name, .up-detail-top a");
      if (node) result.author = (node.textContent || "").trim();
    }
    if (!result.title) result.title = document.title.replace(/\s*[-_]\s*bilibili.*$/i, "").trim();
    if (!result.caption) result.caption = result.title;
    return result;
  }

  register({
    id: "bilibili",
    label: "哔哩哔哩",
    match: (host) => hostEndsWith(host, "bilibili.com"),
    extract: bilibiliExtract,
    filename: (ctx) => {
      const parts = [ctx.clean(ctx.meta.author, 32), ctx.clean(ctx.meta.title, 72), ctx.clean(ctx.meta.workId, 24)];
      const base = parts.filter(Boolean).join("-");
      return base || null;
    }
  });

  /* ------------------------------------------------------------ 网易云音乐 */

  register({
    id: "netease",
    label: "网易云音乐",
    match: (host) => host.endsWith("music.163.com"),
    // 网易云把「歌名 - 歌手 - 单曲 - 网易云音乐」直接写在标题里，不需要注入页面。
    fromTitle: (pageTitle) => {
      const match = pageTitle.match(/^(.*?)\s*-\s*(.*?)\s*-\s*(?:单曲|歌曲|专辑|MV)\s*-\s*网易云音乐/);
      if (!match) return null;
      return { title: match[1].trim(), author: match[2].trim(), caption: "" };
    },
    filename: (ctx) => {
      const base = [ctx.clean(ctx.meta.author, 32), ctx.clean(ctx.meta.title, 72)].filter(Boolean).join("-");
      return base || null;
    }
  });

  /* ------------------------------------------------------------ QQ 音乐 */

  register({
    id: "qqmusic",
    label: "QQ 音乐",
    match: (host) => host.endsWith("y.qq.com") || host.endsWith("qqmusic.qq.com"),
    fromTitle: (pageTitle) => {
      const match = pageTitle.match(/^(.*?)\s*[-–]\s*(.*?)\s*[-–]\s*(?:歌曲|单曲|MV|专辑)\s*[-–]/);
      if (!match) return null;
      return { title: match[1].trim(), author: match[2].trim(), caption: "" };
    },
    filename: (ctx) => {
      const base = [ctx.clean(ctx.meta.author, 32), ctx.clean(ctx.meta.title, 72)].filter(Boolean).join("-");
      return base || null;
    }
  });

  /* ------------------------------------------------------------ 央视网 */

  /**
   * 央视页面播的是 /asp/h5e/ 这条「H5 加密」流：只加密视频 ES，音频是明文。
   * 直接抓分片拼起来就是「有声音没画面」。好在央视自己的视频信息接口
   * （vdn.apps.cntv.cn/api/getHttpVideoInfo.do）会返回同内容的明文流 hls_url，
   * 这里就把它取回来替换掉。
   *
   * 注意：明文 CDN 对高档位会「回落」到低档位内容（2000 档实际是 450 档的字节），
   * 所以下面会逐档探一次分片大小，把回落档位剔除，避免标着 720p 实际下到 480p。
   */
  const CCTV_RATE_LABEL = { "450": "480x270", "850": "640x360", "1200": "1280x720", "2000": "1280x720" };
  const CCTV_FALLBACK_RATES = ["450", "850", "1200", "2000"];

  function cctvGuid(url) {
    try {
      const match = new URL(url).pathname.match(/\/asp\/h5e\/hls\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/([^/]+)\//);
      return match ? match[1] : "";
    } catch (error) {
      return "";
    }
  }

  function cctvRate(url) {
    const match = String(url).match(/\/asp\/h5e\/hls\/([^/]+)\//);
    return match ? match[1] : "";
  }

  const cctvInfoCache = new Map();

  /** guid -> Promise<{ hlsUrl, h5eUrl, title, cover } | null> */
  function cctvInfo(guid) {
    if (!cctvInfoCache.has(guid)) {
      cctvInfoCache.set(guid, (async () => {
        try {
          const url = `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${encodeURIComponent(guid)}`;
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) return null;
          const data = await response.json();
          const hlsUrl = String(data.hls_url || "");
          if (!/^https?:\/\//i.test(hlsUrl)) return null;
          const manifest = data.manifest || {};
          return {
            hlsUrl,
            h5eUrl: String(manifest.hls_h5e_url || ""),
            title: String(data.title || "").trim(),
            cover: String(data.image || "").trim()
          };
        } catch (error) {
          return null;
        }
      })());
    }
    return cctvInfoCache.get(guid);
  }

  /** 从播放列表文本里取「档位 -> 分辨率」和第一条分片地址。 */
  function cctvVariants(text) {
    const lines = String(text).split(/\r?\n/);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
      const resolution = (line.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "";
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor].trim();
        if (!next || next[0] === "#") continue;
        const rate = (next.match(/\/hls\/([^/]+)\//) || [])[1] || "";
        if (rate) variants.push({ rate, resolution });
        break;
      }
    }
    return variants;
  }

  function cctvFirstSegment(text) {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (line && line[0] !== "#") return line;
    }
    return "";
  }

  const cctvTableCache = new Map();

  /** guid -> Promise<Array<{ rate, url, resolution }>>：明文源里真实存在的档位。 */
  function cctvPlainTable(guid, info) {
    if (cctvTableCache.has(guid)) return cctvTableCache.get(guid);
    const promise = (async () => {
      let origin = "";
      let tail = "";
      try {
        const parsed = new URL(info.hlsUrl);
        origin = parsed.origin;
        // /asp/hls/main/0303000a/3/default/<guid>/main.m3u8 -> 0303000a/3/default/<guid>
        tail = parsed.pathname.split("/").filter(Boolean).slice(3, -1).join("/");
      } catch (error) {
        return [];
      }
      if (!origin || !tail) return [];

      // 1) 加密主列表里声明了全部档位和分辨率，用它当候选集。
      const declared = new Map();
      if (info.h5eUrl) {
        try {
          const response = await fetch(info.h5eUrl, { credentials: "include" });
          if (response.ok) {
            for (const variant of cctvVariants(await response.text())) {
              if (variant.rate !== "main") declared.set(variant.rate, variant.resolution);
            }
          }
        } catch (error) {
          // 拿不到就用兜底档位列表。
        }
      }
      if (!declared.size) {
        for (const rate of CCTV_FALLBACK_RATES) declared.set(rate, CCTV_RATE_LABEL[rate] || "");
      }

      // 2) 逐档探一次：先拿明文子列表，再对第一条分片发 Range 请求读总长度。
      const probes = await Promise.all([...declared.keys()].map(async (rate) => {
        const playlist = `${origin}/asp/hls/${rate}/${tail}/${rate}.m3u8`;
        try {
          const response = await fetch(playlist, { credentials: "include" });
          if (!response.ok) return null;
          const first = cctvFirstSegment(await response.text());
          if (!first) return null;
          const segment = new URL(first, playlist).href;
          const head = await fetch(segment, { credentials: "include", headers: { Range: "bytes=0-0" } });
          const range = head.headers.get("content-range") || "";
          const size = Number((range.match(/\/(\d+)\s*$/) || [])[1] || 0);
          return { rate, url: playlist, resolution: declared.get(rate) || CCTV_RATE_LABEL[rate] || "", size };
        } catch (error) {
          return null;
        }
      }));

      // 3) 字节数完全相同的档位说明是回落，只保留其中最低的那一档。
      const alive = probes.filter(Boolean).sort((a, b) => Number(a.rate) - Number(b.rate));
      const seenSize = new Set();
      const table = [];
      for (const item of alive) {
        if (!item.size || seenSize.has(item.size)) continue;
        seenSize.add(item.size);
        table.push({ rate: item.rate, url: item.url, resolution: item.resolution });
      }
      return table;
    })();
    cctvTableCache.set(guid, promise);
    return promise;
  }

  register({
    id: "cctv",
    label: "央视网",
    match: (host) => hostEndsWith(host, "cctv.com") || hostEndsWith(host, "cntv.cn"),
    fromTitle: (pageTitle) => {
      const clean = String(pageTitle)
        .replace(/[_\-\|]\s*(?:CCTV节目官网[^_\-|]*|央视网[^_\-|]*|CCTV\.com[^_\-|]*)\s*$/i, "")
        .trim();
      return clean ? { title: clean } : null;
    },
    canResolve: (item) => Boolean(cctvGuid(item.url)),
    resolve: async (item) => {
      const guid = cctvGuid(item.url);
      if (!guid) return null;
      const info = await cctvInfo(guid);
      if (!info) return null;
      const table = await cctvPlainTable(guid, info);
      const suffixBase = info.title || "";

      if (!table.length) {
        // 探不出来就退回明文主列表，让下载器自己挑最高档。
        return { url: info.hlsUrl, title: suffixBase, note: "央视明文源" };
      }

      const wanted = cctvRate(item.url);
      const numeric = Number(wanted);
      const lower = table.filter((entry) => Number(entry.rate) <= numeric || !Number.isFinite(numeric));
      const picked = lower.length ? lower[lower.length - 1] : table[table.length - 1];
      return {
        url: picked.url,
        title: suffixBase,
        suffix: picked.resolution || "",
        note: "央视明文源"
      };
    },
    filename: (ctx) => {
      const fromItem = ctx.clean(ctx.item && ctx.item.title, 80);
      return fromItem || ctx.clean(ctx.meta.title, 80) || null;
    }
  });

  /* ------------------------------------------------------------ YouTube */

  function youtubeVideoId(pageUrl) {
    try {
      const url = new URL(pageUrl);
      if (hostEndsWith(url.hostname, "youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || "";
      if (/^\/(shorts|embed|live|v)\//.test(url.pathname)) return url.pathname.split("/")[2] || "";
      return url.searchParams.get("v") || "";
    } catch (error) {
      return "";
    }
  }

  /**
   * 在页面世界执行。两件事：
   *  1. 读 window.ytInitialPlayerResponse 拿标题 / 作者 / 时长（页面语言，比接口更贴合）；
   *  2. 调 youtubei 播放器接口拿直链。
   *
   * 为什么要用 ANDROID 客户端声明：新版网页端已经改成 SABR 模式，
   * ytInitialPlayerResponse 里既没有 formats 也没有逐格式直链，只有一条
   * serverAbrStreamingUrl，没法直接下载。而 ANDROID 客户端返回的是
   * 带 url 的常规流，且不带 n= 限速参数，可以直接交给下载管理器。
   *
   * 为什么必须在页面世界做：扩展源（chrome-extension://）直接请求会被
   * Google 以 403 拒绝；页面自己的源没有这个问题。
   */
  async function youtubeExtract() {
    const API_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";
    const CLIENT = {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 34,
      osName: "Android",
      osVersion: "14",
      hl: "en",
      gl: "US"
    };

    const result = { author: "", title: "", caption: "", workId: "", cover: "", duration: 0, streams: [] };

    const videoId = (() => {
      try {
        const url = new URL(location.href);
        if (/youtu\.be$/.test(url.hostname)) return url.pathname.split("/").filter(Boolean)[0] || "";
        if (/^\/(shorts|embed|live|v)\//.test(url.pathname)) return url.pathname.split("/")[2] || "";
        return url.searchParams.get("v") || "";
      } catch (error) {
        return "";
      }
    })();
    if (!videoId) return result;
    result.workId = videoId;

    const readPageResponse = () => {
      try {
        const data = window.ytInitialPlayerResponse;
        if (!data || !data.videoDetails) return null;
        if (String(data.videoDetails.videoId || "") !== videoId) return null;
        return data;
      } catch (error) {
        return null;
      }
    };

    const fillDetails = (data) => {
      if (!data || !data.videoDetails) return;
      const details = data.videoDetails;
      result.title = String(details.title || "").trim() || result.title;
      result.author = String(details.author || "").trim() || result.author;
      result.duration = Number(details.lengthSeconds) || result.duration;
      result.caption = String(details.shortDescription || "").trim().slice(0, 600) || result.caption;
      const thumbs = (details.thumbnail && details.thumbnail.thumbnails) || [];
      if (thumbs.length) result.cover = String(thumbs[thumbs.length - 1].url || "");
    };

    fillDetails(readPageResponse());

    // innertube 偶尔会抽风（返回空 streamingData 或直接报错），重试一次再放弃。
    const askPlayer = async () => {
      const response = await fetch(`/youtubei/v1/player?key=${API_KEY}&prettyPrint=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { client: CLIENT },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      });
      if (!response.ok) return null;
      const data = await response.json();
      fillDetails(data);
      return data.streamingData || null;
    };

    let streaming = null;
    for (let attempt = 0; attempt < 2 && !streaming; attempt += 1) {
      try {
        streaming = await askPlayer();
      } catch (error) {
        streaming = null;
      }
      if (!streaming && attempt === 0) await new Promise((resolve) => setTimeout(resolve, 900));
    }

    if (!streaming) return result;

    const streams = [];
    const progressive = [];
    const adaptive = streaming.adaptiveFormats || [];
    const quality = (format) => String(format.qualityLabel || format.quality || "");
    /**
     * googlevideo 的自适应流地址不带 ratebypass，直接用 chrome.downloads 请求会 403：
     * 它既要求带 Range 头，又要求请求来自 youtube.com 这个源（扩展自己的源会被拒）。
     * 所以这类地址必须由扩展注入页面、在页面世界里取回，见 popup.js 的 downloadViaPage()。
     * 渐进式（itag 18）带 ratebypass，可以直接交给下载管理器。
     */
    const pageDownload = (url) => !/[?&]ratebypass=/.test(String(url));

    // 1) 渐进式：一条文件里同时有画面和声音，点一下就能看。
    //    注意 mimeType 长这样：video/mp4; codecs="avc1.42001E, mp4a.40.2"，
    //    音频要看 codecs 里的 mp4a / opus，不能找 "audio/"。
    const hasAudioCodec = (mime) => /audio\//.test(mime) || /(mp4a|opus|vorbis|ac-3|ec-3|flac)/i.test(mime);
    for (const format of streaming.formats || []) {
      if (!format.url) continue;
      const mime = String(format.mimeType || "");
      if (!/^video\//.test(mime) || !hasAudioCodec(mime)) continue;
      progressive.push({
        url: format.url,
        kind: "video",
        ext: /webm/.test(mime) ? "webm" : "mp4",
        mime: mime.split(";")[0],
        size: Number(format.contentLength) || 0,
        duration: Number(format.approxDurationMs) / 1000 || 0,
        title: `${quality(format) || "视频"} 视频+音频（单文件，可直接播放）`,
        hasAudio: true,
        pageDownload: pageDownload(format.url),
        quality: quality(format)
      });
    }
    progressive.sort((a, b) => (b.size || 0) - (a.size || 0));
    if (progressive.length) streams.push(progressive[0]);
    const muxedQuality = progressive.length ? progressive[0].quality : "";

    // 2) 自适应视频轨：同一画质只留编码最兼容的一条；已经有过单文件的画质不再重复列。
    const codecRank = (mime) => {
      if (/avc1/.test(mime)) return 0;
      if (/av01/.test(mime)) return 1;
      if (/vp0?9/.test(mime)) return 2;
      return 3;
    };
    const bestVideo = new Map();
    for (const format of adaptive) {
      if (!format.url) continue;
      const mime = String(format.mimeType || "");
      if (!/^video\//.test(mime)) continue;
      const label = quality(format);
      if (!label || label === muxedQuality) continue;
      const current = bestVideo.get(label);
      if (!current || codecRank(mime) < codecRank(current.mimeType)) bestVideo.set(label, format);
    }
    const videoTracks = [...bestVideo.values()]
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))
      .slice(0, 6);
    for (const format of videoTracks) {
      const mime = String(format.mimeType || "");
      streams.push({
        url: format.url,
        kind: "video",
        ext: /webm/.test(mime) ? "webm" : "mp4",
        mime: mime.split(";")[0],
        size: Number(format.contentLength) || 0,
        duration: Number(format.approxDurationMs) / 1000 || 0,
        title: `${quality(format)} 视频轨（无音频，需配音频）`,
        hasAudio: false,
        pageDownload: pageDownload(format.url),
        quality: quality(format)
      });
    }

    // 3) 音频轨：m4a 最省事，opus 音质更好但部分播放器不认。
    const audioTracks = adaptive.filter((format) => format.url && /^audio\//.test(String(format.mimeType || "")));
    const pickAudio = (pattern) => audioTracks
      .filter((format) => pattern.test(String(format.mimeType || "")))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
    const m4a = pickAudio(/mp4a/);
    const opus = pickAudio(/opus/);
    if (m4a) {
      streams.push({
        url: m4a.url,
        kind: "audio",
        ext: "m4a",
        mime: "audio/mp4",
        size: Number(m4a.contentLength) || 0,
        title: `音频 ${Math.round((Number(m4a.bitrate) || 0) / 1000)}kbps（m4a，推荐）`,
        hasAudio: true,
        pageDownload: pageDownload(m4a.url),
        bestAudio: true
      });
    }
    if (opus) {
      streams.push({
        url: opus.url,
        kind: "audio",
        ext: "weba",
        mime: "audio/webm",
        size: Number(opus.contentLength) || 0,
        title: `音频 ${Math.round((Number(opus.bitrate) || 0) / 1000)}kbps（opus）`,
        hasAudio: true,
        pageDownload: pageDownload(opus.url)
      });
    }

    result.streams = streams;
    return result;
  }

  register({
    id: "youtube",
    label: "YouTube",
    match: (host) => hostEndsWith(host, "youtube.com") || hostEndsWith(host, "youtu.be") || hostEndsWith(host, "youtube-nocookie.com"),
    extract: youtubeExtract,
    cacheKey: youtubeVideoId,
    cacheMs: 10 * 60 * 1000,
    // 取到直链之后，页面自己发的 googlevideo 分片请求就没有展示价值了。
    // 注意别把自己生成的条目（source=youtube）也藏掉；顺带滤掉 YouTube 的界面音效。
    hideItem: (item) => {
      if (item.source === "youtube") return false;
      if (/youtube\.com\/s\/search\/audio\//.test(item.url)) return true;
      try {
        return hostEndsWith(new URL(item.url).hostname, "googlevideo.com");
      } catch (error) {
        return false;
      }
    },
    filename: (ctx) => {
      const author = ctx.clean(ctx.meta.author, 32);
      const raw = ctx.item && ctx.item.title ? ctx.item.title : ctx.meta.title;
      // 去掉「（无音频，需配音频）」这类说明，文件名里不需要。
      const title = ctx.clean(String(raw || "").replace(/（[^）]*）/g, ""), 72);
      const base = [author, title].filter(Boolean).join("-");
      return base || null;
    }
  });

  root.Platforms = { adapters, register, find };
})(typeof globalThis !== "undefined" ? globalThis : self);
