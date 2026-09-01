// Login gate + static host for the official iPolloWork web UI.
//
// ipollowork-server itself does not serve the SPA, so this small Node process:
//   1. shows a password login (IPOLLOWORK_WEB_PASSWORD) and issues a signed cookie;
//   2. serves the official @ipollowork/app web build from IPOLLOWORK_WEB_ROOT,
//      injecting the worker client token into index.html (localStorage keys the
//      app reads: ipollowork.server.urlOverride / ipollowork.server.token) so the
//      UI is connected to this worker the moment it loads;
//   3. reverse-proxies everything else (server API, /opencode/*, SSE, upgrades)
//      to ipollowork-server on 127.0.0.1.
// API clients that present an Authorization header (desktop app, Den) pass
// straight through, and /health stays public for Railway health checks.

import http from "node:http";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const LISTEN_PORT = Number(process.env.PORT ?? "8787");
const UPSTREAM_PORT = Number(process.env.IPOLLOWORK_INTERNAL_PORT ?? "8786");
const PASSWORD = (process.env.IPOLLOWORK_WEB_PASSWORD ?? "").trim();
const CLIENT_TOKEN = (process.env.IPOLLOWORK_TOKEN ?? "").trim();
const WEB_ROOT = (process.env.IPOLLOWORK_WEB_ROOT ?? "").trim();
const SECRET = (process.env.IPOLLOWORK_WEB_SESSION_SECRET ?? "").trim()
  || crypto.createHash("sha256").update(`gate:${PASSWORD}:${CLIENT_TOKEN}`).digest("hex");
const SESSION_TTL_S = Number(process.env.IPOLLOWORK_WEB_SESSION_TTL_SECONDS ?? String(30 * 24 * 3600));
const COOKIE = "ipw_gate";
const TITLE = process.env.IPOLLOWORK_WEB_TITLE ?? "iPolloWork";

if (!PASSWORD) {
  console.error("[web-gate] IPOLLOWORK_WEB_PASSWORD is empty; refusing to start");
  process.exit(1);
}
if (!WEB_ROOT) {
  console.error("[web-gate] IPOLLOWORK_WEB_ROOT is empty; refusing to start");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

let indexHtmlCache = null;
async function indexHtml() {
  if (indexHtmlCache) return indexHtmlCache;
  const raw = await readFile(resolve(WEB_ROOT, "index.html"), "utf8");
  // Connect the SPA to this worker: same origin for the server API, and the
  // worker client token. Only authenticated (cookie) users ever receive this.
  const boot = `<script>(function(){try{var o=window.location.origin;var t=${JSON.stringify(CLIENT_TOKEN)};
if(t){if(localStorage.getItem("ipollowork.server.urlOverride")!==o)localStorage.setItem("ipollowork.server.urlOverride",o);
if(localStorage.getItem("ipollowork.server.token")!==t)localStorage.setItem("ipollowork.server.token",t);}}catch(e){}})()</script>`
    .replace(/</g, (m, i, str) => (str.startsWith("<script", i) || str.startsWith("</script", i) ? m : "\\u003c"));
  const idx = raw.toLowerCase().indexOf("<head>");
  indexHtmlCache = idx >= 0 ? raw.slice(0, idx + 6) + boot + raw.slice(idx + 6) : boot + raw;
  return indexHtmlCache;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return false;
  }
  const root = resolve(WEB_ROOT);
  const target = resolve(root, rel || "index.html");
  if (target !== root && !target.startsWith(root + sep)) return false;
  let isIndex = !rel || rel === "index.html";
  if (!isIndex) {
    const st = await stat(target).catch(() => null);
    if (!st?.isFile()) {
      // SPA deep link (e.g. /session/<id>): no file, browser navigation -> index.html
      const accept = req.headers.accept ?? "";
      if (accept.includes("text/html") && !extname(rel)) {
        isIndex = true;
      } else {
        return false;
      }
    }
  }
  if (!isIndex) {
    const ext = extname(target).toLowerCase();
    const headers = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    res.end(await readFile(target));
    return true;
  }
  const html = await indexHtml();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

// Browser navigations (GET/HEAD accepting text/html, no file extension) are
// SPA routes -> index.html. Everything else (fetch/XHR with */* or JSON accept,
// non-GET, SSE) is the server API. /health is handled before we get here.
function looksLikeApi(req, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return true;
  if (pathname.startsWith("/opencode/") || pathname === "/opencode") return true;
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html")) return false;
  return !pathname.includes(".");
}

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function issueCookie() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const payload = `${exp}.${crypto.randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

function cookieValid(value) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  const given = parts[2];
  if (expected.length !== given.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return false;
  return Number(parts[0]) > Math.floor(Date.now() / 1000);
}

function readCookie(req) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function passwordMatches(candidate) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · ${escapeHtml(TITLE)}</title>
<style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e7e9ee}
form{width:min(360px,92vw);padding:32px 28px;border:1px solid #23283a;border-radius:16px;background:#12151e;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 22px;color:#9aa3b5;font-size:14px}
label{display:block;font-size:13px;color:#9aa3b5;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #2b3145;background:#0b0d12;color:#e7e9ee;font-size:15px}
input:focus{outline:2px solid #6c8cff;border-color:transparent}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#6c8cff;color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.err{color:#ff7b7b;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/__gate/login" autocomplete="off">
<h1>${escapeHtml(TITLE)}</h1><p>Enter the workbench password to continue.</p>
<label for="pw">Password</label><input id="pw" name="password" type="password" autofocus required>
<button type="submit">Sign in</button>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
</form></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorized(req) {
  if (req.headers.authorization) return true; // API clients bring their own token
  return cookieValid(readCookie(req));
}

function isPublicPath(pathname) {
  return pathname === "/health" || pathname === "/__gate/health";
}

function proxy(req, res) {
  const headers = { ...req.headers };
  delete headers.cookie; // never leak the gate cookie upstream
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] ?? "https";
  const upstream = http.request(
    { host: "127.0.0.1", port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "upstream_unavailable", message: String(err.message ?? err) }));
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gate");

  if (url.pathname === "/__gate/login") {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const params = new URLSearchParams(body);
    const candidate = params.get("password") ?? "";
    if (!passwordMatches(candidate)) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loginPage("Incorrect password."));
      return;
    }
    const cookie = `${COOKIE}=${encodeURIComponent(issueCookie())}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
    res.writeHead(303, { location: "/", "set-cookie": cookie, "cache-control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname === "/__gate/logout") {
    res.writeHead(303, {
      location: "/",
      "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  if (isPublicPath(url.pathname)) {
    proxy(req, res);
    return;
  }

  if (isAuthorized(req)) {
    // Static asset or SPA route -> serve the UI; otherwise -> server API.
    if ((req.method === "GET" || req.method === "HEAD") && !looksLikeApi(req, url.pathname)) {
      try {
        if (await serveStatic(req, res, url.pathname)) return;
      } catch (err) {
        console.error("[web-gate] static error", err);
      }
    }
    proxy(req, res);
    return;
  }

  const accept = req.headers.accept ?? "";
  if (req.method === "GET" && accept.includes("text/html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loginPage());
    return;
  }
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ code: "unauthorized", message: "Sign in to the web UI or send an Authorization header" }));
});

// WebSocket / upgrade passthrough (same auth rules).
server.on("upgrade", (req, socket, head) => {
  if (!isAuthorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const headers = { ...req.headers };
  delete headers.cookie;
  const upstream = http.request({ host: "127.0.0.1", port: UPSTREAM_PORT, method: req.method, path: req.url, headers });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      for (const item of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${item}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0; // long-lived SSE streams

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[web-gate] listening on :${LISTEN_PORT}, ui=${WEB_ROOT}, api -> 127.0.0.1:${UPSTREAM_PORT}`);
});
