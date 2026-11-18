const MAX_MESSAGE_BYTES = 1_900_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGES = 5;
const FILE_PREFIX = "clipboard/";
const UPLOAD_GRACE_MS = 60 * 60 * 1000;
const MESSAGE_COLUMNS = "id, text, created_at, file_name, file_size";
const textEncoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return htmlResponse(APP_HTML);
    }

    if (url.pathname === "/robots.txt" && request.method === "GET") {
      return robotsResponse();
    }

    if (url.pathname === "/favicon.svg" && request.method === "GET") {
      return svgResponse(FAVICON_SVG);
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      return handleList(request, env);
    }

    if (url.pathname === "/api/messages" && request.method === "POST") {
      return handleCreate(request, env);
    }

    if (url.pathname === "/api/messages" && request.method === "DELETE") {
      return handleClear(request, env);
    }

    if (url.pathname === "/api/files" && request.method === "POST") {
      return handleUpload(request, env);
    }

    const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)(\/file)?$/);
    if (messageMatch) {
      const id = Number(messageMatch[1]);
      if (messageMatch[2] && request.method === "GET") {
        return handleDownload(request, env, id);
      }
      if (!messageMatch[2] && request.method === "DELETE") {
        return handleDelete(request, env, id);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env) {
    if (env.FILES) await cleanOrphanedFiles(env);
  }
};

async function handleList(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  const { results } = await env.DB.prepare(
    "SELECT " + MESSAGE_COLUMNS + " FROM messages ORDER BY id DESC LIMIT ?"
  ).bind(MAX_MESSAGES).all();

  return jsonResponse({ messages: results.map(formatMessage) });
}

async function handleCreate(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return jsonResponse({ error: "Text is required" }, 400);
  }
  if (getUtf8ByteLength(text) > MAX_MESSAGE_BYTES) {
    return jsonResponse({ error: "文字过长" }, 400);
  }

  return saveMessage(env, env.DB.prepare(
    "INSERT INTO messages (text, created_at) VALUES (?, ?) RETURNING " + MESSAGE_COLUMNS
  ).bind(text, Date.now()));
}

async function handleUpload(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;
  if (!env.FILES) return jsonResponse({ error: "文件存储未配置" }, 503);

  const name = getUploadName(request);
  if (!name) return jsonResponse({ error: "文件名无效" }, 400);

  const length = request.headers.get("Content-Length");
  if (length === null || !/^\d+$/.test(length)) {
    return jsonResponse({ error: "无法确定文件大小" }, 411);
  }
  const size = Number(length);
  if (size > MAX_FILE_BYTES) {
    return jsonResponse({ error: "单个文件不得超过 50 MiB" }, 413);
  }
  if (size > 0 && !request.body) {
    return jsonResponse({ error: "缺少文件内容" }, 400);
  }

  const key = FILE_PREFIX + crypto.randomUUID();
  let file;
  try {
    file = await env.FILES.put(key, size === 0 ? new Uint8Array(0) : request.body);
  } catch (error) {
    console.error("R2 upload failed", error);
    return jsonResponse({ error: "上传失败，请重试" }, 502);
  }

  // Only add files whose uploads are still too recent for orphan cleanup.
  return saveMessage(env, env.DB.prepare(
    "INSERT INTO messages (text, created_at, file_key, file_name, file_size) "
      + "SELECT '', ?, ?, ?, ? WHERE ? > unixepoch() * 1000 - ? RETURNING " + MESSAGE_COLUMNS
  ).bind(Date.now(), key, name, file.size, file.uploaded.getTime(), UPLOAD_GRACE_MS));
}

function getUploadName(request) {
  try {
    const name = decodeURIComponent(request.headers.get("X-File-Name") || "");
    if (!name.trim() || name === "." || name === ".." || getUtf8ByteLength(name) > 1024) {
      return "";
    }
    return /[\x00-\x1f\x7f/\\]/.test(name) ? "" : name;
  } catch {
    return "";
  }
}

async function saveMessage(env, insert) {
  const prune = env.DB.prepare(
    "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?) RETURNING file_key"
  ).bind(MAX_MESSAGES);
  const [created, removed] = await env.DB.batch([insert, prune]);
  await deleteFiles(env, removed.results);

  const message = created.results[0];
  if (!message) return jsonResponse({ error: "上传已超时，请重试" }, 503);
  return jsonResponse({ message: formatMessage(message) }, 201);
}

function formatMessage({ id, text, created_at, file_name, file_size }) {
  if (file_name !== null) {
    return { id, created_at, type: "file", name: file_name, size: file_size };
  }
  return { id, text, created_at };
}

async function handleDownload(request, env, id) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;
  if (!isValidMessageId(id)) return jsonResponse({ error: "Invalid message id" }, 400);
  if (!env.FILES) return jsonResponse({ error: "文件存储未配置" }, 503);

  const message = await env.DB.prepare(
    "SELECT file_key, file_name FROM messages WHERE id = ?"
  ).bind(id).first();
  if (!message?.file_key) return jsonResponse({ error: "文件已从历史中移除" }, 404);

  const file = await env.FILES.get(message.file_key);
  if (!file) return jsonResponse({ error: "文件已从历史中移除" }, 404);

  const name = encodeURIComponent(message.file_name).replace(/['()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
  return new Response(file.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      "content-disposition": "attachment; filename=\"download\"; filename*=UTF-8''" + name,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

async function deleteFiles(env, removed) {
  const keys = removed.map(({ file_key }) => file_key).filter(Boolean);
  if (!env.FILES || !keys.length) return;
  try {
    await env.FILES.delete(keys);
  } catch (error) {
    console.error("R2 cleanup failed", error);
  }
}

async function cleanOrphanedFiles(env) {
  const cutoff = Math.floor(Date.now() / 1000) * 1000 - UPLOAD_GRACE_MS;
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: FILE_PREFIX, cursor });
    const candidates = page.objects.filter(({ uploaded }) => uploaded.getTime() <= cutoff);
    if (candidates.length) {
      const { results } = await env.DB.prepare(
        "SELECT file_key FROM messages WHERE file_key IS NOT NULL"
      ).all();
      const active = new Set(results.map(({ file_key }) => file_key));
      const orphaned = candidates.filter(({ key }) => !active.has(key));
      if (orphaned.length) await env.FILES.delete(orphaned.map(({ key }) => key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function handleClear(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  const { results } = await env.DB.prepare("DELETE FROM messages RETURNING file_key").all();
  await deleteFiles(env, results);
  return jsonResponse({ ok: true });
}

async function handleDelete(request, env, id) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;
  if (!isValidMessageId(id)) return jsonResponse({ error: "Invalid message id" }, 400);

  const { results } = await env.DB.prepare(
    "DELETE FROM messages WHERE id = ? RETURNING file_key"
  ).bind(id).all();
  await deleteFiles(env, results);
  return jsonResponse({ ok: true, deleted: results.length > 0 });
}

function isValidMessageId(id) {
  return Number.isSafeInteger(id) && id >= 1;
}

async function requireAuth(request, env) {
  if (!env.APP_TOKEN) {
    return jsonResponse({ error: "APP_TOKEN secret is not configured" }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const isValid = await secureEqual(token, env.APP_TOKEN);

  if (!isValid) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  return null;
}

async function secureEqual(a, b) {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);

  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i += 1) {
    diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  }

  return diff === 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function robotsResponse() {
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function svgResponse(svg) {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function getUtf8ByteLength(value) {
  return textEncoder.encode(value).length;
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2563eb"/>
  <path d="M18 14h21l9 9v27H18z" fill="#fff" opacity=".96"/>
  <path d="M39 14v10h9" fill="none" stroke="#bfdbfe" stroke-width="4" stroke-linejoin="round"/>
  <path d="M20 39h19" fill="none" stroke="#2563eb" stroke-width="5" stroke-linecap="round"/>
  <path d="m34 30 10 9-10 9" fill="none" stroke="#2563eb" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>TextPort</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-soft: #eef3f7;
      --text: #161a1d;
      --muted: #667078;
      --border: #d8dee5;
      --accent: #2563eb;
      --accent-strong: #1d4ed8;
      --accent-text: #ffffff;
      --danger: #b42318;
      --danger-bg: #fff1f0;
      --focus: rgb(37 99 235 / 18%);
      --shadow: 0 18px 45px rgb(23 35 48 / 10%);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111417;
        --surface: #191d21;
        --surface-soft: #222930;
        --text: #f3f6f8;
        --muted: #9aa6b2;
        --border: #323a43;
        --accent: #60a5fa;
        --accent-strong: #93c5fd;
        --accent-text: #07111f;
        --danger: #ff9b90;
        --danger-bg: #2a1716;
        --focus: rgb(96 165 250 / 22%);
        --shadow: 0 18px 45px rgb(0 0 0 / 22%);
      }
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, var(--surface-soft) 0, var(--bg) 320px),
        var(--bg);
      color: var(--text);
    }

    main {
      width: min(760px, 100%);
      margin: 0 auto;
      padding: 28px 18px 40px;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .status {
      min-height: 28px;
      max-width: 260px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      text-align: right;
    }

    .shell {
      display: grid;
      gap: 14px;
    }

    section {
      background: color-mix(in srgb, var(--surface) 94%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    label,
    .section-title {
      display: block;
      color: var(--text);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.25;
    }

    .hint {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }

    .character-count {
      white-space: nowrap;
    }

    textarea,
    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      line-height: 1.5;
      padding: 12px 13px;
      outline: none;
    }

    textarea {
      min-height: 132px;
      resize: vertical;
    }

    textarea::placeholder,
    input::placeholder {
      color: color-mix(in srgb, var(--muted) 78%, transparent);
    }

    textarea:focus,
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--focus);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }

    .message-actions {
      justify-content: space-between;
    }

    .message-actions-left {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .selected-files {
      margin-top: 8px;
      overflow-wrap: anywhere;
      white-space: pre-line;
    }

    button {
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.2;
      padding: 10px 14px;
      cursor: pointer;
      transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 140ms ease;
    }

    button:hover {
      border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
    }

    button:active {
      transform: translateY(1px);
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-text);
    }

    button.primary:hover {
      border-color: var(--accent-strong);
      background: var(--accent-strong);
    }

    button.danger {
      border-color: color-mix(in srgb, var(--danger) 38%, var(--border));
      background: var(--danger-bg);
      color: var(--danger);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.62;
      transform: none;
    }

    .token-panel {
      display: none;
    }

    .message-list {
      display: grid;
      gap: 10px;
    }

    .message {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      cursor: pointer;
      text-align: left;
      padding: 12px 13px;
      transition: border-color 140ms ease, background 140ms ease;
    }

    .message:hover {
      border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
      background: color-mix(in srgb, var(--surface) 88%, var(--surface-soft));
    }

    .message-file {
      cursor: default;
    }

    .file-size {
      display: block;
    }

    .message:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--focus);
      outline: none;
    }

    .message-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: start;
    }

    .message-text {
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 15px;
      font-weight: 400;
      line-height: 1.5;
    }

    .message.is-collapsed .message-text {
      position: relative;
      max-height: 7.5em;
      overflow: hidden;
    }

    .message.is-collapsed .message-text::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 2.2em;
      background: linear-gradient(180deg, transparent, var(--surface));
      pointer-events: none;
    }

    .message.is-collapsed:hover .message-text::after {
      background: linear-gradient(
        180deg,
        transparent,
        color-mix(in srgb, var(--surface) 88%, var(--surface-soft))
      );
    }

    .message-icon-button {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      min-height: 28px;
      border-radius: 6px;
      color: var(--muted);
      padding: 0;
    }

    .message-download {
      min-height: 28px;
      padding: 4px 8px;
    }

    .message-toggle {
      visibility: hidden;
      pointer-events: none;
    }

    .message.is-collapsible .message-toggle {
      visibility: visible;
      pointer-events: auto;
    }

    .message-delete {
      border-color: color-mix(in srgb, var(--danger) 38%, var(--border));
      background: var(--danger-bg);
      color: var(--danger);
    }

    .message-delete:hover {
      border-color: var(--danger);
      color: var(--danger);
    }

    .message-time {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      padding: 18px 14px;
      text-align: center;
    }

    footer {
      margin-top: 20px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      text-align: center;
    }

    footer a {
      color: inherit;
      font-weight: 700;
    }

    @media (max-width: 560px) {
      main {
        padding: 20px 14px 28px;
      }

      header {
        align-items: flex-start;
        flex-direction: column;
        margin-bottom: 14px;
      }

      h1 {
        font-size: 26px;
      }

      .status {
        min-height: 20px;
        max-width: none;
        text-align: left;
      }

      section {
        padding: 14px;
      }

      .section-head {
        align-items: flex-start;
        flex-direction: column;
        gap: 4px;
      }

      .actions button {
        flex: 1 1 calc(50% - 6px);
      }

      .actions button.primary {
        flex-basis: 100%;
      }

      .message-actions {
        align-items: stretch;
      }

      .message-actions-left {
        flex: 1 1 auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>TextPort</h1>
      <div id="status" class="status" role="status"></div>
    </header>

    <div class="shell">
      <section id="tokenPanel" class="token-panel">
        <div class="section-head">
          <label for="tokenInput">访问密钥</label>
          <span class="hint">只保存在当前浏览器</span>
        </div>
        <input id="tokenInput" type="password" autocomplete="current-password" placeholder="粘贴 APP_TOKEN">
        <div class="actions">
          <button id="saveTokenButton" class="primary" type="button">保存密钥</button>
        </div>
      </section>

      <section>
        <div class="section-head">
          <label for="textInput">剪贴板</label>
          <span id="characterCount" class="hint character-count">0 字符 · 保存最近 5 条</span>
        </div>
        <textarea id="textInput" placeholder="输入文字，或在此粘贴文件"></textarea>
        <input id="fileInput" type="file" multiple hidden>
        <div id="selectedFiles" class="hint selected-files" hidden></div>
        <div class="actions message-actions">
          <div class="message-actions-left">
            <button id="sendButton" class="primary" type="button">发送文字</button>
            <button id="chooseFilesButton" type="button">选择文件</button>
            <button id="uploadButton" class="primary" type="button" hidden>上传文件</button>
            <button id="removeFilesButton" type="button" hidden>移除待上传文件</button>
            <button id="refreshButton" type="button">刷新</button>
          </div>
          <button id="clearButton" class="danger" type="button">清空历史</button>
        </div>
      </section>

      <section>
        <div class="section-head">
          <div class="section-title">最近记录</div>
          <span class="hint">点击文字复制，点击「下载」保存文件</span>
        </div>
        <div id="messages" class="message-list"></div>
      </section>
    </div>
    <footer>Copyright © 2026 Luca. All rights reserved. <a href="https://github.com/YuanzeSun/TextPort" rel="noopener noreferrer" target="_blank">GitHub</a></footer>
  </main>

  <script>
    const tokenPanel = document.querySelector("#tokenPanel");
    const tokenInput = document.querySelector("#tokenInput");
    const saveTokenButton = document.querySelector("#saveTokenButton");
    const textInput = document.querySelector("#textInput");
    const fileInput = document.querySelector("#fileInput");
    const selectedFilesEl = document.querySelector("#selectedFiles");
    const chooseFilesButton = document.querySelector("#chooseFilesButton");
    const uploadButton = document.querySelector("#uploadButton");
    const removeFilesButton = document.querySelector("#removeFilesButton");
    const sendButton = document.querySelector("#sendButton");
    const refreshButton = document.querySelector("#refreshButton");
    const clearButton = document.querySelector("#clearButton");
    const messagesEl = document.querySelector("#messages");
    const statusEl = document.querySelector("#status");
    const characterCountEl = document.querySelector("#characterCount");

    const TOKEN_KEY = "textport-token";
    const MAX_MESSAGE_BYTES = 1900000;
    const MAX_FILE_BYTES = ${MAX_FILE_BYTES};
    const MAX_MESSAGES = ${MAX_MESSAGES};
    const COLLAPSE_MESSAGE_CHARACTERS = 360;
    const COLLAPSE_MESSAGE_LINES = 8;
    const textEncoder = new TextEncoder();
    const characterSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
      : null;

    let statusTimeout;
    let pendingFiles = [];
    let uploadingFiles = false;

    function tokenFromHash() {
      const hash = new URLSearchParams(location.hash.slice(1));
      return hash.get("token") || "";
    }

    function getToken() {
      const fromHash = tokenFromHash();
      if (fromHash) {
        localStorage.setItem(TOKEN_KEY, fromHash);
        return fromHash;
      }
      return localStorage.getItem(TOKEN_KEY) || "";
    }

    function requireToken() {
      const token = getToken();
      tokenPanel.style.display = token ? "none" : "block";
      return token;
    }

    function setStatus(text, duration = 0) {
      clearTimeout(statusTimeout);
      statusEl.textContent = text;
      if (duration) statusTimeout = setTimeout(() => setStatus(""), duration);
    }

    function getUtf8ByteLength(value) {
      return textEncoder.encode(value).length;
    }

    function countCharacters(value) {
      if (!value) return 0;
      if (!characterSegmenter) return Array.from(value).length;

      let count = 0;
      for (const _segment of characterSegmenter.segment(value)) {
        count += 1;
      }
      return count;
    }

    function updateCharacterCount() {
      characterCountEl.textContent = countCharacters(textInput.value) + " 字符 · 保存最近 5 条";
    }

    function isLongMessage(text) {
      return Array.from(text).length > COLLAPSE_MESSAGE_CHARACTERS
        || text.split(/\\r\\n|\\r|\\n/).length > COLLAPSE_MESSAGE_LINES;
    }

    async function api(path, options = {}, download = false) {
      const token = requireToken();
      if (!token) {
        throw new Error("请先填写访问密钥");
      }

      const response = await fetch(path, {
        ...options,
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });

      if (response.ok && download) return response.blob();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "请求失败");
      }

      return body;
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
    }

    function renderPendingFiles() {
      const hasFiles = pendingFiles.length > 0;
      selectedFilesEl.hidden = uploadButton.hidden = removeFilesButton.hidden = !hasFiles;
      chooseFilesButton.disabled = uploadButton.disabled = removeFilesButton.disabled = uploadingFiles;
      selectedFilesEl.textContent = pendingFiles.map((file) =>
        file.name + " · " + formatFileSize(file.size)
      ).join("\\n");
    }

    function stageFiles(files) {
      if (uploadingFiles || !files.length) return;
      if (pendingFiles.length + files.length > MAX_MESSAGES) {
        setStatus("一次最多选择 " + MAX_MESSAGES + " 个文件");
        return;
      }
      if (files.some((file) => file.size > MAX_FILE_BYTES)) {
        setStatus("单个文件不得超过 50 MiB");
        return;
      }
      pendingFiles.push(...files);
      renderPendingFiles();
      setStatus("");
    }

    async function uploadFiles() {
      if (uploadingFiles || !pendingFiles.length) return;
      uploadingFiles = true;
      renderPendingFiles();
      const total = pendingFiles.length;
      let sent = 0;
      let failure = "";

      try {
        while (pendingFiles.length) {
          const file = pendingFiles[0];
          setStatus("正在上传 " + (sent + 1) + " / " + total + "...");
          await api("/api/files", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-File-Name": encodeURIComponent(file.name)
            },
            body: file
          });
          pendingFiles.shift();
          sent += 1;
          renderPendingFiles();
        }
      } catch (error) {
        failure = error.message;
      }

      if (sent) {
        try {
          await refreshMessages(false);
        } catch {
          failure ||= "刷新失败，请手动刷新";
        }
      }
      uploadingFiles = false;
      renderPendingFiles();
      const summary = sent ? "已上传 " + sent + " 个文件" : "";
      setStatus([summary, failure].filter(Boolean).join("，"), failure ? 0 : 1200);
    }

    async function downloadFile(message) {
      const blob = await api("/api/messages/" + message.id + "/file", {}, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = message.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function renderMessages(messages) {
      messagesEl.textContent = "";

      if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "还没有记录";
        messagesEl.append(empty);
        return;
      }

      for (const message of messages) {
        const isFile = message.type === "file";
        const item = document.createElement("div");
        item.className = isFile ? "message message-file" : "message";

        const body = document.createElement("div");
        body.className = "message-body";

        const content = document.createElement("div");
        content.className = "message-text";
        content.textContent = isFile ? message.name : message.text;

        const action = document.createElement("button");
        action.type = "button";
        if (isFile) {
          const size = document.createElement("span");
          size.className = "hint file-size";
          size.textContent = formatFileSize(message.size);
          content.append(size);
          action.className = "message-download";
          action.textContent = "下载";
          action.addEventListener("click", async () => {
            action.disabled = true;
            setStatus("正在下载...");
            try {
              await downloadFile(message);
              setStatus("已下载", 1200);
            } catch (error) {
              setStatus(error.message);
            } finally {
              action.disabled = false;
            }
          });
        } else {
          enableTextActions(item, action, message.text);
        }

        const deleteButton = document.createElement("button");
        deleteButton.className = "message-icon-button message-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "×";
        deleteButton.title = "删除";
        deleteButton.setAttribute("aria-label", "删除消息");

        const time = document.createElement("div");
        time.className = "message-time";
        time.textContent = new Date(message.created_at).toLocaleString();

        body.append(content, action, deleteButton);
        item.append(body, time);

        deleteButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (!confirm("删除这条历史？")) return;

          deleteButton.disabled = true;
          try {
            await deleteMessage(message.id);
          } catch (error) {
            setStatus(error.message);
          } finally {
            deleteButton.disabled = false;
          }
        });

        messagesEl.append(item);
      }
    }

    function enableTextActions(item, toggle, text) {
      item.role = "button";
      item.tabIndex = 0;
      const copyMessage = async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("已复制", 1200);
        } catch {
          setStatus("复制失败，请手动选择文字");
        }
      };
      item.addEventListener("click", copyMessage);
      item.addEventListener("keydown", (event) => {
        if (event.target !== item || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        copyMessage();
      });

      toggle.className = "message-icon-button message-toggle";
      if (!isLongMessage(text)) return;
      item.classList.add("is-collapsible", "is-collapsed");
      toggle.textContent = "▶";
      toggle.title = "展开";
      toggle.setAttribute("aria-label", "展开消息");
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const isExpanded = item.classList.toggle("is-expanded");
        item.classList.toggle("is-collapsed", !isExpanded);
        toggle.textContent = isExpanded ? "▼" : "▶";
        toggle.title = isExpanded ? "折叠" : "展开";
        toggle.setAttribute("aria-label", isExpanded ? "折叠消息" : "展开消息");
        toggle.setAttribute("aria-expanded", String(isExpanded));
      });
    }

    async function refreshMessages(announce = true) {
      if (announce) setStatus("正在刷新...");
      const body = await api("/api/messages");
      renderMessages(body.messages || []);
      if (announce) setStatus("已刷新", 1200);
    }

    async function sendMessage() {
      const text = textInput.value.trim();
      if (!text) {
        setStatus("请输入文字");
        return;
      }
      if (getUtf8ByteLength(text) > MAX_MESSAGE_BYTES) {
        setStatus("文字过长");
        return;
      }

      sendButton.disabled = true;
      setStatus("正在发送...");

      try {
        await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ text })
        });
        textInput.value = "";
        updateCharacterCount();
        await refreshMessages(false);
        setStatus("已发送", 1200);
      } finally {
        sendButton.disabled = false;
      }
    }

    async function clearMessages() {
      if (!confirm("清空历史？")) return;
      await api("/api/messages", { method: "DELETE" });
      await refreshMessages(false);
      setStatus("历史已清空", 1200);
    }

    async function deleteMessage(id) {
      await api("/api/messages/" + encodeURIComponent(id), { method: "DELETE" });
      await refreshMessages(false);
      setStatus("已删除", 1200);
    }

    saveTokenButton.addEventListener("click", () => {
      const token = tokenInput.value.trim();
      if (!token) return;
      localStorage.setItem(TOKEN_KEY, token);
      tokenInput.value = "";
      requireToken();
      refreshMessages().catch((error) => setStatus(error.message));
    });

    sendButton.addEventListener("click", () => {
      sendMessage().catch((error) => setStatus(error.message));
    });

    chooseFilesButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      stageFiles(Array.from(fileInput.files));
      fileInput.value = "";
    });
    uploadButton.addEventListener("click", uploadFiles);
    removeFilesButton.addEventListener("click", () => {
      pendingFiles = [];
      renderPendingFiles();
      setStatus("");
    });

    refreshButton.addEventListener("click", () => {
      refreshMessages().catch((error) => setStatus(error.message));
    });

    clearButton.addEventListener("click", () => {
      clearMessages().catch((error) => setStatus(error.message));
    });

    textInput.addEventListener("input", updateCharacterCount);
    textInput.addEventListener("change", updateCharacterCount);
    textInput.addEventListener("keyup", updateCharacterCount);
    textInput.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) {
        event.preventDefault();
        stageFiles(files);
      } else {
        requestAnimationFrame(updateCharacterCount);
      }
    });

    requireToken();
    updateCharacterCount();
    refreshMessages().catch((error) => setStatus(error.message));
  </script>
</body>
</html>`;
