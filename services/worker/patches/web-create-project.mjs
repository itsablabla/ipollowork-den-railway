// Build-time patch for the browser (web) build of @ipollowork/app.
// Upstream "New project" requires a folder chosen through the desktop's native
// directory picker; in a browser there is no picker, so creation always fails
// with "Project creation failed." On a hosted worker the sensible default is a
// sibling folder of the current project on the server (e.g. /data/<name>).
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
let src = readFileSync(file, "utf8");
const anchor = 'if (!folderPath) throw new Error(t("projects.create_failed"));';
if (src.split(anchor).length !== 2) {
  console.error(`[patch] expected exactly one anchor in ${file}`);
  process.exit(1);
}
const replacement = `if (!folderPath && !isDesktopRuntime()) {
      // Browser build: no native folder picker. Create the project next to the
      // current server-side project folder.
      const base = workspaces.find((workspace) => workspace.workspaceType !== "remote" && typeof workspace.path === "string" && workspace.path.trim())?.path?.trim() ?? "";
      const parent = base.replace(/[\\\\/]+$/, "").split(/[\\\\/]/).slice(0, -1).join("/") || "/data";
      const safeName = name.replace(/[\\\\/:*?"<>|]+/g, "-").replace(/\\s+/g, " ").trim();
      if (safeName) folderPath = \`\${parent}/\${safeName}\`;
    }
    ${anchor}`;
src = src.replace(anchor, replacement);
if (!/isDesktopRuntime/.test(src.slice(0, src.indexOf("const createProject = useCallback")))) {
  console.error("[patch] isDesktopRuntime is not imported in session-route.tsx");
  process.exit(1);
}
writeFileSync(file, src);
console.log("[patch] web create-project fallback applied");
