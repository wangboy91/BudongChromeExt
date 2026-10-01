/**
 * MAIN world（页面世界）钩子。
 *
 * 网络层（webRequest）看不到 blob: 地址，因为那是页面自己用
 * URL.createObjectURL 造出来的内存流。这里把该函数包一层，
 * 一旦页面为音频/视频创建 blob 就回报给隔离世界的内容脚本。
 *
 * 与内容脚本的通信只用 window.postMessage，不读写页面任何数据。
 */
(function () {
  const FLAG = "__mediaSniffer";
  if (window[FLAG]) return;

  const captured = [];
  const MAX = 60;

  function post(message) {
    try {
      window.postMessage(Object.assign({ __mediaSniffer: true }, message), "*");
    } catch (error) {
      // 忽略：页面可能限制了 postMessage 目标。
    }
  }

  function record(url, mime, size) {
    captured.push({ url, mime, size });
    if (captured.length > MAX) captured.shift();
    post({ type: "BLOB_MEDIA", url, mime, size });
  }

  const original = URL.createObjectURL;
  if (typeof original === "function" && !original.__mediaSniffer) {
    const wrapped = function (object) {
      const url = original.call(this, object);
      try {
        if (typeof url === "string" && url.indexOf("blob:") === 0) {
          const mime = object && typeof object.type === "string" ? object.type : "";
          const size = object && typeof object.size === "number" ? object.size : 0;
          if (!mime || /^(audio|video)\//.test(mime) || mime === "application/ogg") {
            record(url, mime, size);
          }
        }
      } catch (error) {
        // 记录失败不能影响页面本身。
      }
      return url;
    };
    wrapped.__mediaSniffer = true;
    URL.createObjectURL = wrapped;
  }

  // 内容脚本准备好后会发 READY，此时把之前抓到的 blob 重发一遍，避免竞态丢消息。
  window.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || data.__mediaSniffer !== true || data.type !== "READY") return;
    for (const item of captured) {
      post({ type: "BLOB_MEDIA", url: item.url, mime: item.mime, size: item.size });
    }
  });

  window[FLAG] = true;
})();
