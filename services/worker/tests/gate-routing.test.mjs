// Unit checks for web-gate.mjs routing decisions (run: node services/worker/tests/gate-routing.test.mjs)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../web-gate.mjs"), "utf8");
const block = src.match(/const API_TOP[\s\S]*?\nfunction looksLikeApi[\s\S]*?\n}\n/)?.[0];
if (!block) throw new Error("routing block not found in web-gate.mjs");
const { looksLikeApi } = new Function(`${block}; return { isApiPath, looksLikeApi };`)();
const nav = (p) => looksLikeApi({ method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }, p);
const xhr = (p) => looksLikeApi({ method: "GET", headers: { accept: "*/*" } }, p);

const cases = [
  // [path, isApi when navigated by a browser]
  ["/", false], ["/help", false], ["/settings/ai", false],
  ["/workspace/ws_1/session", false], ["/workspace/ws_1/session/ses_2", false], ["/workspace/ws_1/settings/extensions", false],
  ["/workspace/ws_1/files/raw", true], ["/workspace/ws_1/sessions", true], ["/workspace/ws_1/opencode/event", true],
  ["/workspace/ws_1/artifacts/a1", true], ["/w/ws_1/opencode/config", true], ["/opencode/config", true],
  ["/health", true], ["/workspaces", true], ["/tokens", true], ["/env/keys", true], ["/approvals", true],
];
let failed = 0;
for (const [p, expected] of cases) {
  const got = nav(p);
  if (got !== expected) { failed++; console.error(`FAIL nav ${p}: expected api=${expected} got ${got}`); }
}
if (xhr("/anything") !== true) { failed++; console.error("FAIL xhr without html accept should be api"); }
if (xhr("/assets/app.js") !== false) { failed++; console.error("FAIL asset request should be static"); }
if (looksLikeApi({ method: "POST", headers: { accept: "text/html" } }, "/workspace/ws_1/session") !== true) { failed++; console.error("FAIL POST must be api"); }
if (failed) process.exit(1);
console.log(`gate routing: ${cases.length + 3} checks ok`);
