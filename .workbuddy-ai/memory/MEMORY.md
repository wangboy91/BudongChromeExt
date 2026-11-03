# BudongChromeExt 项目长期记忆

「王不懂的AI」制作的浏览器扩展集合。每个扩展一个子目录，各自含 `manifest.json`，在 Chrome 里分别「加载已解压的扩展程序」。

## 目录约定

- 根 `README.md` 里有一张扩展清单表格，**新增扩展后要同步更新**。
- 扩展目录内各自带 `README.md`，写清安装、用法、实现原理、隐私权限、已知限制。
- 扩展之间不共享代码，各自的 `popup.css` 独立；但视觉语言统一：**暗色**（`#202124` 底 / `#26282c` 头部）、主色 `#4eabed`、卡片式列表、底部状态栏。

## 已有扩展

| 目录 | 说明 |
| --- | --- |
| `douyin-reference-downloader/` | 抖音参考视频下载。读 `RENDER_DATA` + React fiber 拿多清晰度 MP4。 |
| `media-downloader/` | 音视频下载（通用）。webRequest + DOM 扫描 + blob 钩子，支持 HLS 合并、预览播放器；`platforms.js` 做平台增强（抖音/B站/网易云/QQ音乐/央视网/YouTube）。 |

## 通用嗅探 + 平台增强的分层约定（media-downloader）

- **通用层**必须能独立工作：任何站点都靠 webRequest + DOM 扫描嗅探到，不依赖站点专属逻辑。
- **平台层**只做增强，永远可选、永远可失败：命中适配器就多给「作者/标题/文案」和更好的文件名；没命中或读不到数据就静默退回通用行为。
- 新增平台只需在 `platforms.js` 加一条 `register({...})`，不改其他文件。
- `extract()` 走 `world:"MAIN"` 注入，**必须自包含**；`filename()` 只返回不含扩展名的基名。
- 适配器可选钩子：`canResolve`/`resolve`（把嗅探到的地址换成可下载地址）、`hideItem`（滤掉无价值条目）、`cacheKey`/`cacheMs`。
- `extract()` 返回的 `streams` 会被追加进列表。条目可带 **`pageDownload: true`**，表示这条地址
  必须由页面世界带 `Range` 取回（`popup.js` 的 `pageFetchAndSave` → Blob → 页面 `<a download>`）。
  适用于 googlevideo 这类「既查 Range 头又查来源」的地址。
- 内容脚本注入顺序有依赖：`content.js` 第一行就读 `globalThis.MediaTypes`，所以 manifest 的
  `content_scripts` 里 **`media-types.js` 必须排在 `content.js` 前面**（漏了会导致内容脚本整体不执行）。

## 验证踩坑（写测试脚本时）

- 用 CDP 的 `Browser.setDownloadBehavior` 会让 Chrome **忽略** `chrome.downloads.download` 的
  `filename` 参数（文件名退化成 URL 名或 blob UUID）。要验证文件名，就预先往 profile 的
  `Default/Preferences` 写 `download.default_directory`，别用 CDP 的下载行为。
- 无头 Chrome 里加载扩展：`Extensions.loadUnpacked` + 打开
  `chrome-extension://<id>/popup.html` 当宿主页，用 `chrome.scripting.executeScript` 驱动。


## 技术约定

- 全部 Manifest V3，**零构建、零依赖**，原生 JS + CSS，不引入打包器。
- 公共逻辑抽成普通脚本（如 `media-types.js`），后台用 `importScripts`、弹窗用 `<script>`、内容脚本在 manifest 里按顺序列出，保持单一事实来源。
- 不读取/上传 Cookie 或页面内容；需要带凭据的请求靠浏览器自带会话（`credentials: "include"`）。
- 图标统一用 `tools/make-icons.py`（纯标准库，4 倍超采样）生成，避免提交二进制源文件。
