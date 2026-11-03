
chrome.runtime.onInstalled.addListener(go);
go();

async function go() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: "https://www.douyin.com/" },
          { header: "origin", operation: "set", value: "https://www.douyin.com" }
        ]
      },
      condition: { urlFilter: "127.0.0.1", resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "object", "other", "image", "script", "stylesheet", "font", "ping", "csp_report", "websocket", "webtransport", "webbundle"] }
    }]
  });
  await new Promise((r) => setTimeout(r, 500));
  try {
    const id = await chrome.downloads.download({ url: "http://127.0.0.1/file.bin", filename: "probe.bin", saveAs: false });
    console.log("download started", id);
  } catch (error) {
    console.log("download failed", String(error));
  }
}
