/**
 * 共享的媒体类型判定工具。
 * 同时被后台 service worker（importScripts）、内容脚本与弹窗复用，
 * 保证「什么是音频、扩展名怎么取」在三处完全一致。
 */
(function (root) {
  const AUDIO_EXT = [
    "mp3", "mp2", "m4a", "m4b", "m4r", "aac", "wav", "wave", "flac", "alac",
    "ogg", "oga", "opus", "weba", "aiff", "aif", "aifc", "amr", "wma", "ape",
    "mka", "ac3", "eac3", "dts", "caf", "au", "ra", "mid", "midi", "dsf", "dff", "tak", "wv"
  ];
  const VIDEO_EXT = [
    "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "ts", "mts", "m2ts", "wmv", "3gp", "ogv", "mpg", "mpeg", "m2v", "f4v"
  ];
  const HLS_EXT = ["m3u8", "m3u"];
  const DASH_EXT = ["mpd"];

  const MIME_TO_EXT = {
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/x-mpeg": "mp3", "audio/mpeg3": "mp3",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/aacp": "aac",
    "audio/x-aac": "aac", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav", "audio/vnd.wave": "wav",
    "audio/flac": "flac", "audio/x-flac": "flac", "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "opus",
    "audio/webm": "weba", "audio/x-ms-wma": "wma", "audio/x-ms-asf": "wma", "audio/amr": "amr", "audio/aiff": "aiff",
    "audio/x-aiff": "aiff", "audio/basic": "au", "audio/midi": "mid", "audio/x-midi": "mid", "audio/3gpp": "3gp",
    "audio/3gpp2": "3g2", "audio/ac3": "ac3", "audio/eac3": "eac3", "audio/x-matroska": "mka",
    "video/mp4": "mp4", "video/webm": "webm", "video/x-matroska": "mkv", "video/quicktime": "mov", "video/x-msvideo": "avi",
    "video/x-flv": "flv", "video/mp2t": "ts", "video/x-ms-wmv": "wmv", "video/3gpp": "3gp", "video/ogg": "ogv",
    "application/vnd.apple.mpegurl": "m3u8", "application/x-mpegurl": "m3u8", "audio/mpegurl": "m3u8",
    "audio/x-mpegurl": "m3u8", "application/mpegurl": "m3u8", "application/x-mpegURL": "m3u8",
    "application/dash+xml": "mpd", "video/vnd.dlna.mpeg-tts": "ts"
  };

  const audioSet = new Set(AUDIO_EXT);
  const videoSet = new Set(VIDEO_EXT);
  const hlsSet = new Set(HLS_EXT);
  const dashSet = new Set(DASH_EXT);

  /** 从 URL 中取小写扩展名（忽略 query/hash）。取不到返回 ""。 */
  function extFromUrl(url) {
    if (typeof url !== "string") return "";
    let path = url;
    const cut = path.search(/[?#]/);
    if (cut >= 0) path = path.slice(0, cut);
    const match = path.match(/\.([a-z0-9]{1,6})$/i);
    return match ? match[1].toLowerCase() : "";
  }

  /** 归一化 content-type：去掉 charset 等参数，转小写。 */
  function normalizeMime(mime) {
    if (typeof mime !== "string") return "";
    return mime.split(";")[0].trim().toLowerCase();
  }

  function kindFromExt(ext) {
    if (!ext) return "";
    if (audioSet.has(ext)) return "audio";
    if (videoSet.has(ext)) return "video";
    if (hlsSet.has(ext)) return "hls";
    if (dashSet.has(ext)) return "dash";
    return "";
  }

  function kindFromMime(mime) {
    const m = normalizeMime(mime);
    if (!m) return "";
    if (m === "application/dash+xml") return "dash";
    if (m.indexOf("audio/mpegurl") >= 0 || m.indexOf("x-mpegurl") >= 0 || m === "application/vnd.apple.mpegurl") return "hls";
    if (m.indexOf("audio/") === 0) return "audio";
    if (m.indexOf("video/") === 0) return "video";
    if (m === "application/ogg") return "audio";
    return "";
  }

  function extFromMime(mime) {
    const m = normalizeMime(mime);
    if (!m) return "";
    if (MIME_TO_EXT[m]) return MIME_TO_EXT[m];
    if (m.indexOf("audio/") === 0) return m.slice(6).replace(/^x-/, "").replace(/[^a-z0-9]/g, "").slice(0, 5);
    if (m.indexOf("video/") === 0) return m.slice(6).replace(/^x-/, "").replace(/[^a-z0-9]/g, "").slice(0, 5);
    return "";
  }

  /** 从 content-disposition 里取文件名。 */
  function filenameFromDisposition(value) {
    if (typeof value !== "string") return "";
    const star = value.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
    if (star) {
      try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch (e) { /* ignore */ }
    }
    const plain = value.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
    if (plain) return (plain[1] || plain[2] || "").trim();
    return "";
  }

  /**
   * 综合判定一个资源是不是媒体。
   * @param {{url?:string, mime?:string, disposition?:string, requestType?:string, blob?:boolean}} input
   * @returns {{kind:string, ext:string, mime:string, confidence:number}|null}
   */
  function describe(input) {
    const url = input && input.url ? input.url : "";
    const mime = normalizeMime(input && input.mime);
    const disposition = (input && input.disposition) || "";
    const requestType = (input && input.requestType) || "";

    const urlExt = extFromUrl(url);
    const urlKind = kindFromExt(urlExt);
    const mimeKind = kindFromMime(mime);
    const nameExt = extFromUrl(filenameFromDisposition(disposition));
    const nameKind = kindFromExt(nameExt);

    // 1) 服务端明确给出的媒体类型最可信。
    if (mimeKind) {
      return { kind: mimeKind, ext: extFromMime(mime) || nameExt || urlExt || "", mime, confidence: 3 };
    }
    // 2) 明确的非媒体响应（HTML 错误页等）直接排除。
    if (mime === "text/html" || mime === "application/xhtml+xml") return null;
    // 3) 再看 URL 后缀。注意 .ts 既是 MPEG-TS 也是 TypeScript，用 mime 区分。
    if (urlKind) {
      if (urlExt === "ts" && /^(application\/(javascript|ecmascript|json|typescript)|text\/)/.test(mime)) return null;
      return { kind: urlKind, ext: urlExt, mime, confidence: 3 };
    }
    // 4) content-disposition 里的文件名。
    if (nameKind) {
      return { kind: nameKind, ext: nameExt, mime, confidence: 2 };
    }
    // 5) 浏览器把 <audio>/<video> 发出的请求标记为 media。即使服务端返回
    //    application/octet-stream（签名直链很常见），也说明这是媒体资源。
    if (requestType === "media") {
      return { kind: "audio", ext: urlExt || "", mime, confidence: 1 };
    }
    return null;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let index = 0;
    let size = value;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    const total = Math.floor(Number(seconds));
    if (!Number.isFinite(total) || total <= 0) return "";
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function sanitizeFilename(value, limit) {
    return String(value == null ? "" : value)
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit || 80);
  }

  /** 标题 -> 可作为文件名的基名。 */
  function basename(title, fallback) {
    const clean = sanitizeFilename(title, 80);
    return clean || fallback || "音频";
  }

  /** 站点名，用作文件名前缀，方便区分来源。 */
  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  const api = {
    AUDIO_EXT, VIDEO_EXT, HLS_EXT, DASH_EXT,
    extFromUrl, normalizeMime, kindFromExt, kindFromMime, extFromMime,
    filenameFromDisposition, describe, formatBytes, formatDuration,
    sanitizeFilename, basename, hostLabel
  };

  root.MediaTypes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
