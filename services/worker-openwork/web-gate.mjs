// Minimal login gate in front of openwork-server's built-in web UI.
//
// openwork-server can serve the OpenWork web app itself (OPENWORK_WEB_ROOT) and
// injects the worker client token into index.html so the SPA is ready to use.
// That is great on a private network and dangerous on a public Railway URL,
// because anyone who loads the page gets the token. This gate adds a password
// login (OPENWORK_WEB_PASSWORD) and only forwards browser traffic that carries a
// valid signed session cookie. API clients that already present an
// Authorization header (desktop app, Den) pass straight through, and /health
// stays public so Railway health checks keep working.

import http from "node:http";
import crypto from "node:crypto";

const LISTEN_PORT = Number(process.env.PORT ?? "8787");
const UPSTREAM_PORT = Number(process.env.OPENWORK_INTERNAL_PORT ?? "8786");
const PASSWORD = (process.env.OPENWORK_WEB_PASSWORD ?? "").trim();
const SECRET = (process.env.OPENWORK_WEB_SESSION_SECRET ?? "").trim()
  || crypto.createHash("sha256").update(`gate:${PASSWORD}:${process.env.OPENWORK_TOKEN ?? ""}`).digest("hex");
const SESSION_TTL_S = Number(process.env.OPENWORK_WEB_SESSION_TTL_SECONDS ?? String(30 * 24 * 3600));
const COOKIE = "ow_gate";
const TITLE = process.env.OPENWORK_WEB_TITLE ?? "OpenWork";

if (!PASSWORD) {
  console.error("[web-gate] OPENWORK_WEB_PASSWORD is empty; refusing to start");
  process.exit(1);
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

  if (isPublicPath(url.pathname) || isAuthorized(req)) {
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
  console.log(`[web-gate] listening on :${LISTEN_PORT}, forwarding to 127.0.0.1:${UPSTREAM_PORT}`);
});
