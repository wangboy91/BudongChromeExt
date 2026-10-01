# 音视频下载

一个「通用型」音视频下载 Chrome 扩展：只要页面上出现过音视频请求（不管是 `<audio>`/`<video>` 标签、`fetch`/XHR 拉的、还是没有后缀的签名直链），打开弹窗就能看到并保存。支持 **HLS 流**（`.m3u8` 分片自动拉取、解密、合并成一个文件）。

设计原则是 **通用嗅探打底，平台适配只做增强**：

- 任何站点都能被嗅探到 —— 靠通用的网络嗅探 + DOM 扫描，不依赖任何站点专属逻辑；
- 认得出的平台额外多做两件事 —— 读出作者/标题/**文案**，并用它拼出更好读的文件名；
- 没适配的站点、或适配了但没读到数据的站点，**一律退回通用行为**，不会报错也不会少一个条目。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录 `media-downloader`（含 `manifest.json` 的那一层）。
3. 建议把它固定到工具栏。

要求 Chrome 111 以上（用到了 `world: "MAIN"` 的内容脚本）。

> 如果你之前加载过旧目录 `audio-downloader`，先在 `chrome://extensions` 里把它移除，再按新路径重新加载 —— 目录已随扩展改名调整。

## 用法

1. 打开网页，**先点一下播放**。
2. 点扩展图标，弹窗会列出当前标签页嗅探到的所有资源：
   - 左侧色块是格式（`MP3` / `FLAC` / `HLS` / `MEM` 等）
   - 标题下方是来源域名、MIME、大小、时长
   - 三个按钮：`▶` 预览、`⧉` 复制地址、`↓ 下载`
3. 点 `▶` 会在列表上方展开一个播放器：**音频**是原生播放条，**视频**是内嵌 `<video>` 画面，两者都带进度条 / 音量 / 全屏控件。点右上角 `↗` 可以丢到新标签页，用浏览器自带播放器看完整尺寸。
   - 再次点 `▶`（变成 `⏸`）或点播放器右上角 `×` 停止预览
   - **兜底**：弹窗是 `chrome-extension://` 源，有些站点（抖音 CDN 这类）会校验 `Referer` 而拒绝。这时会自动改在**页面右下角**开一个播放器 —— 那边带的是页面自身的来源与 Cookie，能正常加载，看完点 `×` 关掉即可
   - HLS/DASH 和 `blob:` 内存流无法直接预览（前者要先合并，后者跨源读不到），按钮会置灰并说明原因
4. 命中平台适配时，工具栏下方会多出一张**文案卡**：显示平台名、作者、作品 ID 和正文文案，点「复制文案」一键复制。切换作品后点右上角「↻」重新读取。
5. 需要批量保存时点右上角「全部下载」（按当前筛选结果）。
6. 顶部标签可切换 `全部 / 音频 / 视频 / 流媒体`；「⌫」清空当前标签页的列表。

底部两个开关：

| 开关 | 作用 |
| --- | --- |
| 保存前询问位置 | 勾选后每次下载都会弹出 Chrome 的另存为窗口 |
| 显示流分片 | HLS/DASH 的分片默认会被折叠隐藏，勾选后可以看到每一个 `.ts` / `.m4s` |

## 平台适配现状

| 平台 | 元信息读取方式 | 文件命名 |
| --- | --- | --- |
| 抖音 | 页面世界读 `RENDER_DATA` + React fiber，拿作者、文案、作品 ID | `博主昵称-作品标题-作品ID.mp4` |
| 哔哩哔哩 | 页面世界读 `window.__INITIAL_STATE__`，拿 UP 主、标题、简介、BV 号 | `UP主-标题-BV号.mp4` |
| 网易云音乐 | 解析页面标题「歌名 - 歌手 - 单曲 - 网易云音乐」 | `歌手-歌名.mp3` |
| QQ 音乐 | 解析页面标题「歌名 - 歌手 - 歌曲 - QQ音乐…」 | `歌手-歌名.m4a` |
| **其他所有站点** | 不做适配 | `标题-站点-短哈希.ext`（通用规则） |

## 怎么加一个新平台

只需要在 `platforms.js` 里追加一条 `register({...})`，不用动其他任何文件：

```js
register({
  id: "example",
  label: "示例站",
  match: (host) => host.endsWith("example.com"),
  // 可选：在页面世界执行，读页面已有的数据。必须自包含（不能引用外部变量）。
  extract: function () {
    return { author: "", title: "", caption: "", workId: "", cover: "" };
  },
  // 可选：不用注入页面，直接从 <title> 解析。
  fromTitle: (pageTitle) => null,
  // 可选：返回不含扩展名的基名；返回 null 表示交回通用命名。
  filename: (ctx) => `${ctx.clean(ctx.meta.author, 32)}-${ctx.clean(ctx.meta.title, 72)}` || null
});
```

`extract` 会被 `chrome.scripting.executeScript({ world: "MAIN" })` 序列化后注入页面，所以**辅助函数必须写在它内部**，不能引用 `platforms.js` 里的任何外部变量。扩展名由弹窗统一补，适配器只管基名。

## 支持的格式

- **音频**：mp3、m4a、aac、wav、flac、ogg、oga、opus、weba、aiff、amr、wma、ape、mka、ac3、caf、au、mid、dsf…
- **视频**：mp4、webm、mkv、mov、flv、ts、3gp…
- **流媒体**：HLS（`.m3u8`，含主/媒体播放列表、`#EXT-X-MAP` 初始化分片、AES-128 加密）；DASH（`.mpd`）只做识别，需要 ffmpeg 合并，会提示你复制地址。
- **特殊来源**：`blob:` 内存流（页面用 `URL.createObjectURL` 或 MSE 造出来的）也能保存。

## 它是怎么找到音视频的

三条通道互补，最终按「标签页 + 地址」去重合并：

| 通道 | 实现 | 能覆盖 |
| --- | --- | --- |
| 网络嗅探（发起） | `webRequest.onBeforeRequest` | 地址带后缀的直链 |
| 网络嗅探（响应） | `webRequest.onHeadersReceived` 读 `content-type` / `content-disposition` / `content-length` / `content-range` | **没有后缀的签名直链**（靠 MIME 判定）、真实文件大小 |
| 页面扫描 | 内容脚本读 `<audio>/<video>/<source>`、`<a href>`、`performance` 资源 | 网络层看不到的 `blob:`、以及扩展中途安装时已经加载完的资源 |
| 页面钩子 | MAIN world 包装 `URL.createObjectURL` | 还没挂到播放器上的内存流 |

判定优先级：服务端 MIME → URL 后缀 → `content-disposition` 文件名 → 「浏览器把该请求标记为 media」。
其中最后一条是关键：签名直链常常没有后缀、还返回 `application/octet-stream`，但只要它是 `<audio>` 发出的，就一定算音频。

三种下载路径：

- **直链** → `chrome.downloads.download`
- **blob:** → 在页面世界把内存流读成 data URL（超过 32 MB 则退回页面原生保存）
- **HLS** → 解析播放列表（自动从主列表挑码率最高的纯音频轨）→ 并发拉取分片 → AES-128 解密 → 拼接为 `.ts` 或 `.m4a`

## 隐私与权限

扩展不读取、不导出、不上传 Cookie 或页面内容，所有处理都在本地。拉取 HLS 分片时使用的是浏览器自带的会话凭据（`credentials: include`），不会额外收集。

权限说明：

- `webRequest` + `<all_urls>`：嗅探媒体请求（只观察，不拦截、不改写）
- `downloads`：调用 Chrome 下载管理器
- `scripting`：读取 `blob:` 内存流、执行平台适配器
- `tabs`：按标签页归类资源、显示角标数量
- `storage`：记住两个开关；会话级缓存用 `storage.session`，不落盘

## 已知限制

- 加密流只支持 HLS 的 `AES-128`；`SAMPLE-AES`、Widevine 等 DRM 一律不处理。
- 直播流（播放列表里没有 `#EXT-X-ENDLIST`、持续滚动）无法拼成完整文件。
- DASH（`.mpd`）只识别不合并。
- 网易云音乐、QQ 音乐等平台的曲库有版权保护，扩展只做「能播就能存」——即浏览器已经加载出来的那条地址；不会去破解会员或音质限制。请只下载你有权使用的内容。
- 平台适配是「尽力而为」：站点改版后 `extract` 可能读不到数据，此时会自动退回通用命名，条目本身不受影响。

## 实测参考站点

[mossland.studio/voice/library](https://mossland.studio/voice/library)：该站是 Nuxt SPA，音色通过 REST 接口返回直链（`audioUrl` / `audioSampleUrl`），点击试听时由 `<audio>` 加载。打开音色库、点任意音色的播放键，再打开扩展，即可看到该条音频并直接下载（该站没有做平台适配，走通用命名）。

## 文件结构

```
media-downloader/
├─ manifest.json       MV3 清单
├─ media-types.js      媒体类型判定（后台/内容脚本/弹窗共用）
├─ platforms.js        平台适配表：文案提取 + 文件命名
├─ background.js       service worker：网络嗅探 + 按标签页汇总 + 角标
├─ content.js          隔离世界内容脚本：DOM 扫描与上报
├─ hook.js             MAIN world 钩子：捕获 blob 内存流
├─ popup.html/css/js   弹窗界面、预览播放器与三种下载路径
├─ icons/              图标（由 tools/make-icons.py 生成）
└─ tools/make-icons.py 纯标准库图标生成脚本
```

图标可重新生成：

```bash
python tools/make-icons.py
```
