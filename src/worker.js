const MAX_MESSAGE_BYTES = 1_900_000;
const MAX_MESSAGES = 5;
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

    const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/);
    if (messageMatch && request.method === "DELETE") {
      return handleDelete(request, env, Number(messageMatch[1]));
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};

async function handleList(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  const { results } = await env.DB.prepare(
    "SELECT id, text, created_at FROM messages ORDER BY id DESC LIMIT ?"
  ).bind(MAX_MESSAGES).all();

  return jsonResponse({ messages: results });
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

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return jsonResponse({ error: "Text is required" }, 400);
  }
  if (getUtf8ByteLength(text) > MAX_MESSAGE_BYTES) {
    return jsonResponse({ error: "文字过长" }, 400);
  }

  const createdAt = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO messages (text, created_at) VALUES (?, ?) RETURNING id, text, created_at"
  ).bind(text, createdAt).first();

  await env.DB.prepare(
    "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)"
  ).bind(MAX_MESSAGES).run();

  return jsonResponse({ message: result }, 201);
}

async function handleClear(request, env) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  await env.DB.prepare("DELETE FROM messages").run();
  return jsonResponse({ ok: true });
}

async function handleDelete(request, env, id) {
  const unauthorized = await requireAuth(request, env);
  if (unauthorized) return unauthorized;

  if (!Number.isSafeInteger(id) || id < 1) {
    return jsonResponse({ error: "Invalid message id" }, 400);
  }

  const result = await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true, deleted: result.meta.changes > 0 });
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
      <div id="status" class="status"></div>
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
          <label for="textInput">发送文字</label>
          <span id="characterCount" class="hint character-count">0 字符 · 保存最近 5 条</span>
        </div>
        <textarea id="textInput"></textarea>
        <div class="actions message-actions">
          <div class="message-actions-left">
            <button id="sendButton" class="primary" type="button">发送</button>
            <button id="refreshButton" type="button">刷新</button>
          </div>
          <button id="clearButton" class="danger" type="button">清空历史</button>
        </div>
      </section>

      <section>
        <div class="section-head">
          <div class="section-title">最近文字</div>
          <span class="hint">点击任意条目复制</span>
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
    const sendButton = document.querySelector("#sendButton");
    const refreshButton = document.querySelector("#refreshButton");
    const clearButton = document.querySelector("#clearButton");
    const messagesEl = document.querySelector("#messages");
    const statusEl = document.querySelector("#status");
    const characterCountEl = document.querySelector("#characterCount");

    const TOKEN_KEY = "textport-token";
    const MAX_MESSAGE_BYTES = 1900000;
    const COLLAPSE_MESSAGE_CHARACTERS = 360;
    const COLLAPSE_MESSAGE_LINES = 8;
    const textEncoder = new TextEncoder();
    const characterSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
      : null;

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

    function setStatus(text) {
      statusEl.textContent = text || "";
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

    async function api(path, options = {}) {
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

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "请求失败");
      }

      return body;
    }

    function renderMessages(messages) {
      messagesEl.textContent = "";

      if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "还没有文字";
        messagesEl.append(empty);
        return;
      }

      for (const message of messages) {
        const item = document.createElement("div");
        item.className = "message";
        item.role = "button";
        item.tabIndex = 0;

        const body = document.createElement("div");
        body.className = "message-body";

        const text = document.createElement("div");
        text.className = "message-text";
        text.textContent = message.text;

        const toggle = document.createElement("button");
        toggle.className = "message-icon-button message-toggle";
        toggle.type = "button";
        toggle.textContent = "▶";
        toggle.title = "展开";
        toggle.setAttribute("aria-label", "展开消息");
        toggle.setAttribute("aria-expanded", "false");

        const deleteButton = document.createElement("button");
        deleteButton.className = "message-icon-button message-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "×";
        deleteButton.title = "删除";
        deleteButton.setAttribute("aria-label", "删除消息");

        const time = document.createElement("div");
        time.className = "message-time";
        time.textContent = new Date(message.created_at).toLocaleString();

        const isCollapsible = isLongMessage(message.text);
        if (isCollapsible) {
          item.classList.add("is-collapsible", "is-collapsed");
        }

        body.append(text, toggle, deleteButton);
        item.append(body, time);

        const copyMessage = async () => {
          try {
            await navigator.clipboard.writeText(message.text);
            setStatus("已复制");
            setTimeout(() => setStatus(""), 1200);
          } catch {
            setStatus("复制失败，请手动选择文字");
          }
        };

        item.addEventListener("click", copyMessage);
        item.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          copyMessage();
        });

        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          const isExpanded = item.classList.toggle("is-expanded");
          item.classList.toggle("is-collapsed", !isExpanded);
          toggle.textContent = isExpanded ? "▼" : "▶";
          toggle.title = isExpanded ? "折叠" : "展开";
          toggle.setAttribute("aria-label", isExpanded ? "折叠消息" : "展开消息");
          toggle.setAttribute("aria-expanded", String(isExpanded));
        });

        deleteButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (!confirm("删除这条历史？")) return;

          deleteButton.disabled = true;
          try {
            await deleteMessage(message.id);
          } finally {
            deleteButton.disabled = false;
          }
        });

        messagesEl.append(item);
      }
    }

    async function refreshMessages() {
      setStatus("正在刷新...");
      const body = await api("/api/messages");
      renderMessages(body.messages || []);
      setStatus("已刷新");
      setTimeout(() => setStatus(""), 1200);
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
        await refreshMessages();
        setStatus("已发送");
        setTimeout(() => setStatus(""), 1200);
      } finally {
        sendButton.disabled = false;
      }
    }

    async function clearMessages() {
      if (!confirm("清空历史？")) return;
      await api("/api/messages", { method: "DELETE" });
      await refreshMessages();
      setStatus("历史已清空");
      setTimeout(() => setStatus(""), 1200);
    }

    async function deleteMessage(id) {
      await api("/api/messages/" + encodeURIComponent(id), { method: "DELETE" });
      await refreshMessages();
      setStatus("已删除");
      setTimeout(() => setStatus(""), 1200);
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

    refreshButton.addEventListener("click", () => {
      refreshMessages().catch((error) => setStatus(error.message));
    });

    clearButton.addEventListener("click", () => {
      clearMessages().catch((error) => setStatus(error.message));
    });

    textInput.addEventListener("input", updateCharacterCount);
    textInput.addEventListener("change", updateCharacterCount);
    textInput.addEventListener("keyup", updateCharacterCount);
    textInput.addEventListener("paste", () => requestAnimationFrame(updateCharacterCount));

    requireToken();
    updateCharacterCount();
    refreshMessages().catch((error) => setStatus(error.message));
  </script>
</body>
</html>`;
