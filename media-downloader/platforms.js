/**
 * 平台适配表。
 *
 * 设计原则：**通用嗅探打底，平台只做增强**。
 * 任何一个站点都能被嗅探到（走 background.js + content.js 的通用逻辑），
 * 这里只负责给「认得出的平台」多做两件事：
 *   1. 从页面里读出元信息（作者 / 标题 / 文案），显示在弹窗里，可一键复制；
 *   2. 用元信息拼出更好读的文件名。
 * 没有命中的站点、或者命中但没读到数据的站点，一律退回通用逻辑，不会报错。
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

  /* ------------------------------------------------------------ 抖音 */

  function douyinExtract() {
    const result = { author: "", title: "", caption: "", workId: "", cover: "" };
    const pick = (address) => {
      if (typeof address === "string") return address.indexOf("http") === 0 ? address : "";
      if (Array.isArray(address)) {
        for (const entry of address) {
          const found = pick(entry);
          if (found) return found;
        }
        return "";
      }
      if (!address || typeof address !== "object") return "";
      return pick(address.src || address.url_list || address.urlList || address.url);
    };

    let page;
    try {
      page = new URL(location.href);
    } catch (error) {
      return result;
    }
    const workId = (page.pathname.match(/\/video\/(\d+)/) || [])[1] || page.searchParams.get("modal_id") || "";
    result.workId = workId;

    const findDetail = (data) => {
      if (!data || typeof data !== "object") return null;
      const root = data.app && data.app.videoDetail;
      if (root && (!workId || String(root.awemeId || root.aweme_id || "") === workId)) return root;
      const queue = [data];
      const seen = new Set();
      for (let index = 0; index < queue.length && index < 30000; index += 1) {
        const item = queue[index];
        if (!item || typeof item !== "object" || seen.has(item)) continue;
        seen.add(item);
        if (String(item.awemeId || item.aweme_id || "") === workId && (item.video || item.desc)) return item;
        for (const value of Object.values(item)) {
          if (value && typeof value === "object") queue.push(value);
        }
      }
      return root || null;
    };

    const apply = (detail) => {
      if (!detail) return false;
      const id = String(detail.awemeId || detail.aweme_id || "");
      if (workId && id && id !== workId) return false;
      const author = detail.author || detail.authorInfo || {};
      result.author = author.nickname || author.nick_name || result.author;
      const desc = String(detail.desc || "").trim();
      const itemTitle = String(detail.itemTitle || "").trim();
      result.caption = desc || itemTitle;
      result.title = itemTitle || desc.split("\n")[0] || "";
      const cover = pick((detail.video && (detail.video.cover || detail.video.coverUrl)) || "");
      if (cover) result.cover = cover;
      if (id) result.workId = id;
      return true;
    };

    // 只认「作品页」。首页 / 推荐流 / 用户页没有具体作品，硬凑出来的
    // 只会是「抖音精选电脑版」这种站点名，反而污染文案卡和文件名。
    if (!workId) return result;

    try {
      const node = document.getElementById("RENDER_DATA");
      if (node && node.textContent) apply(findDetail(JSON.parse(decodeURIComponent(node.textContent))));
    } catch (error) {
      // 页面结构变了就继续往下走。
    }

    // 用户主页 / 搜索页弹窗切换作品时，RENDER_DATA 可能还是上一篇的，
    // 改从当前作品节点的 React fiber 里找。
    if (!result.caption) {
      const holder = document.querySelector('[data-e2e-vid="' + workId + '"]');
      const keys = holder ? Object.getOwnPropertyNames(holder).filter((key) => key.indexOf("__reactFiber") === 0) : [];
      let fiber = keys.length ? holder[keys[0]] : null;
      let levels = 0;
      while (fiber && levels < 30 && !result.caption) {
        const queue = [fiber.memoizedProps, fiber.memoizedState];
        const seen = new Set();
        for (let index = 0; index < queue.length && index < 8000; index += 1) {
          const value = queue[index];
          if (!value || typeof value !== "object" || seen.has(value)) continue;
          seen.add(value);
          if (String(value.awemeId || value.aweme_id || "") === workId && (value.desc || value.video)) {
            apply(value);
            if (result.caption) break;
          }
          for (const next of Object.values(value)) {
            if (next && typeof next === "object") queue.push(next);
          }
        }
        fiber = fiber.return;
        levels += 1;
      }
    }

    // 兜底：作品页的 og:description / <title> 至少能给出标题。
    if (!result.caption) {
      const meta = document.querySelector('meta[property="og:description"], meta[name="description"]');
      if (meta && meta.content) result.caption = meta.content.trim();
    }
    if (!result.title) result.title = document.title.replace(/\s*[-–|]\s*抖音.*$/u, "").trim();
    if (!result.caption) result.caption = result.title;
    return result;
  }

  register({
    id: "douyin",
    label: "抖音",
    match: (host) => host === "douyin.com" || host.endsWith(".douyin.com"),
    extract: douyinExtract,
    filename: (ctx) => {
      const parts = [ctx.clean(ctx.meta.author, 32), ctx.clean(ctx.meta.title, 72), ctx.clean(ctx.meta.workId, 24)];
      const base = parts.filter(Boolean).join("-");
      return base || null;
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
    match: (host) => host === "bilibili.com" || host.endsWith(".bilibili.com"),
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

  root.Platforms = { adapters, register, find };
})(typeof globalThis !== "undefined" ? globalThis : self);
