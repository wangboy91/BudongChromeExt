const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const extensions = ['media-downloader', 'douyin-reference-downloader'];

function context(overrides = {}) {
  class Node {}
  const nodes = [];
  const saved = [];
  const messages = [];
  const document = {
    title: '作品 - 抖音', body: { appendChild: (node) => nodes.push(node) },
    querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
    createElement: () => ({ click() { saved.push(this.download); }, remove() {} })
  };
  const sandbox = { URL, Blob, Uint8Array, AbortSignal, Node, document,
    location: new URL('https://www.douyin.com/video/123'), innerWidth: 1000, innerHeight: 800,
    window: { postMessage: (message) => messages.push(message) }, setTimeout: () => 0,
    ...overrides };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(base, extensions[0], 'douyin.js'), 'utf8'), sandbox);
  return { sandbox, api: sandbox.DouyinMedia, document, saved, messages, Node };
}

function player(ctx, detail, { paused = false, src = 'blob:video' } = {}) {
  const holder = new ctx.Node();
  holder.__reactFiber$test = { memoizedProps: { detail }, return: null };
  return { paused, currentSrc: src, src: '', parentElement: holder, videoWidth: 1080, videoHeight: 1920, duration: 47,
    closest: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, right: 600, bottom: 700 }) };
}

const detail = (id = '123') => ({ awemeId: id, desc: '新作品', authorInfo: { nickname: '作者' },
  video: { width: 1080, height: 1920, duration: 47000,
    bitRateList: [{ width: 1080, height: 1920, dataSize: 32, format: 'mp4', playAddr: [{ src: 'https://v1.douyinvod.com/a' }, { src: 'https://v2.douyinvod.com/a' }] }] } });

test('both standalone packages contain identical page functions and load them before popup code', () => {
  assert.equal(fs.readFileSync(path.join(base, extensions[0], 'douyin.js'), 'utf8'), fs.readFileSync(path.join(base, extensions[1], 'douyin.js'), 'utf8'));
  for (const ext of extensions) {
    const html = fs.readFileSync(path.join(base, ext, 'popup.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.indexOf('douyin.js') < scripts.indexOf('popup.js'));
    for (const file of scripts) assert.ok(fs.existsSync(path.join(base, ext, file)));
    JSON.parse(fs.readFileSync(path.join(base, ext, 'manifest.json'), 'utf8'));
  }
});

test('new player without data-e2e-vid exposes current work and backup CDNs, ignoring stale HTML', () => {
  const ctx = context();
  const current = player(ctx, detail());
  ctx.document.querySelectorAll = () => [current];
  ctx.document.getElementById = () => ({ textContent: encodeURIComponent(JSON.stringify({ app: { videoDetail: detail('999') } })) });
  const result = ctx.api.collect();
  assert.equal(result.detailSource, 'current-player');
  assert.equal(result.workId, '123');
  assert.equal(result.author, '作者');
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].urls.length, 2);
  assert.equal(result.streams[0].pageDownload, true);
});

test('modal ignores unrelated player metadata', () => {
  const ctx = context({ location: new URL('https://www.douyin.com/user/example?modal_id=123') });
  ctx.document.querySelectorAll = () => [player(ctx, detail('999'), { src: 'https://v1.douyinvod.com/current' })];
  const result = ctx.api.collect();
  assert.equal(result.detailId, '');
  assert.equal(result.streams[0].url, 'https://v1.douyinvod.com/current');
  assert.equal(result.author, '');
});

test('recommendation blob player supplies work ID from current React state', () => {
  const ctx = context({ location: new URL('https://www.douyin.com/?recommend=1') });
  ctx.document.querySelectorAll = () => [player(ctx, detail())];
  assert.equal(ctx.api.collect().workId, '123');
});

test('snake_case metadata and HTTPS protocol-relative sources are supported', () => {
  const ctx = context();
  ctx.document.getElementById = () => ({ textContent: encodeURIComponent(JSON.stringify({ aweme_id: '123', video: { bit_rate: [{ play_addr: { url_list: ['//v1.douyinvod.com/a'] }, is_h265: 1 }] } })) });
  const result = ctx.api.collect();
  assert.equal(result.streams[0].url, 'https://v1.douyinvod.com/a');
  assert.equal(result.streams[0].codec, 'HEVC');
});

test('platform registry uses the serializable Douyin collector and preserves other adapters', () => {
  const ctx = context();
  vm.runInContext(fs.readFileSync(path.join(base, 'media-downloader/platforms.js'), 'utf8'), ctx.sandbox);
  assert.equal(ctx.sandbox.Platforms.find('https://www.douyin.com/video/123').extract, ctx.api.collect);
  for (const site of ['https://www.bilibili.com/video/a', 'https://www.youtube.com/watch?v=a', 'https://tv.cctv.com/']) assert.ok(ctx.sandbox.Platforms.find(site));
});

function response(bytes, { status = 200, headers = {} } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': 'video/mp4', ...headers } });
}
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

test('download keeps page Referer, validates full MP4, and preserves filename', async () => {
  const ctx = context({ fetch: async (url, options) => {
    assert.equal(options.referrerPolicy, 'strict-origin-when-cross-origin');
    assert.equal(options.headers.Range, 'bytes=0-');
    return response(mp4, { status: 206, headers: { 'content-range': 'bytes 0-11/12' } });
  } });
  const result = await ctx.api.download({ url: 'https://v1.douyinvod.com/a', workId: '123' }, '作者-作品.mp4');
  assert.equal(result.size, mp4.length);
  assert.deepEqual(ctx.saved, ['作者-作品.mp4']);
});

test('403 on primary CDN retries the original backup URL unchanged', async () => {
  const requests = [];
  const ctx = context({ fetch: async (url) => {
    requests.push(url);
    return requests.length === 1 ? response('denied', { status: 403 }) : response(mp4);
  } });
  const result = await ctx.api.download({ url: 'https://v1.douyinvod.com/a?sign=abc', urls: ['https://v2.douyinvod.com/a?sign=def'] }, 'video.mp4');
  assert.equal(result.size, 12);
  assert.deepEqual(requests, ['https://v1.douyinvod.com/a?sign=abc', 'https://v2.douyinvod.com/a?sign=def']);
});

for (const [name, makeResponse] of [
  ['HTML error disguised as HTTP 200', () => response('<html>denied</html>')],
  ['partial byte range', () => response(mp4, { status: 206, headers: { 'content-range': 'bytes 0-11/100' } })],
  ['truncated body', () => response(mp4, { headers: { 'content-length': '100' } })],
  ['network failure', () => { throw new Error('Failed to fetch'); }]
]) test(`rejects ${name} without creating a download`, async () => {
  const ctx = context({ fetch: async () => makeResponse() });
  const result = await ctx.api.download({ url: 'https://v1.douyinvod.com/a' }, 'video.mp4');
  assert.ok(result.error);
  assert.equal(ctx.saved.length, 0);
  assert.equal(ctx.messages.at(-1).__mediaDownloaderProgress.phase, 'error');
});

test('switching works prevents downloading a stale card', async () => {
  const ctx = context({ fetch: async () => { throw new Error('must not fetch'); } });
  const result = await ctx.api.download({ url: 'https://v1.douyinvod.com/a', workId: '999' }, 'video.mp4');
  assert.match(result.error, /已切换/);
  assert.equal(ctx.saved.length, 0);
});

for (const ext of extensions) test(`${ext}: popup scan and download use serialized MAIN-world functions`, async () => {
  const page = context({ fetch: async () => response(mp4) });
  page.document.querySelectorAll = () => [player(page, detail())];
  const created = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.style = {}; this.dataset = {}; this.value = '0'; this.textContent = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    addEventListener(event, fn) { this.listeners[event] = fn; }
    querySelectorAll() { return []; }
    get childElementCount() { return this.children.length; }
  }
  const elements = new Map();
  const popupDocument = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelector() { return new Element(); },
    createElement(tag) { const el = new Element(tag); created.push(el); return el; },
    createDocumentFragment() { return new Element(); }
  };
  const injections = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ items: [] }) },
    downloads: { download: async () => { assert.fail('must not download Douyin URL from extension origin'); }, onChanged: { addListener() {} } },
    tabs: { query: async () => [{ id: 42, url: page.sandbox.location.href, title: '作品' }] },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async (request) => {
      injections.push(request);
      assert.equal(request.world, 'MAIN');
      assert.equal(request.target.tabId, 42);
      // Chrome serializes functions; closures from the popup must not be required.
      const fn = vm.runInContext(`(${request.func.toString()})`, page.sandbox);
      return [{ result: await fn(...(request.args || [])) }];
    } }
  };
  const sandbox = { document: popupDocument, chrome, URL, Blob, Uint8Array, AbortSignal, setTimeout: () => 0, clearTimeout() {} };
  vm.createContext(sandbox);
  const html = fs.readFileSync(path.join(base, ext, 'popup.html'), 'utf8');
  for (const [, file] of html.matchAll(/<script src="([^"]+)"/g)) vm.runInContext(fs.readFileSync(path.join(base, ext, file), 'utf8'), sandbox);
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
  const download = created.find((el) => el.tagName === 'button' && /(^| )download( |$)/.test(el.className));
  assert.ok(download, `popup should display a download button; status: ${elements.get('status').textContent}`);
  await download.listeners.click();
  assert.equal(injections.length, 2);
  assert.equal(page.saved.length, 1);
  assert.match(page.saved[0], /作者-新作品-123-1080x1920-H264\.mp4/);
  assert.match(elements.get('status').textContent, /保存|取回/);
});
