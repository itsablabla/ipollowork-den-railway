#!/usr/bin/env node
/**
 * Provision the iPolloWork / Openwork Den stack on Railway from a template
 * definition (template/railway-template*.json) using Railway's public GraphQL
 * API, then optionally turn the resulting project into a reusable Railway
 * template with `templateGenerate`.
 *
 * Usage:
 *   RAILWAY_API_TOKEN=... node scripts/railway-provision.mjs \
 *     --template template/railway-template.json \
 *     --name "garza-den" \
 *     --owner-email you@example.com \
 *     [--workspace-id <id>] [--generate-template] [--dry-run]
 *
 * Requires Node 18+ (global fetch). No dependencies.
 * Token: account or workspace token from https://railway.com/account/tokens
 * (sent as `Authorization: Bearer`). Project tokens are NOT sufficient because
 * projectCreate / templateGenerate are account-level operations.
 */
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";

const API = "https://backboard.railway.com/graphql/v2";

// ---------------------------------------------------------------- args
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = arr[i + 1];
      acc.push([key, next && !next.startsWith("--") ? next : "true"]);
    }
    return acc;
  }, []),
);
const templatePath = args.template ?? "template/railway-template.json";
const projectName = args.name ?? "ipollowork-den";
const ownerEmail = args["owner-email"] ?? "";
const workspaceId = args["workspace-id"];
const generateTemplate = args["generate-template"] === "true";
const dryRun = args["dry-run"] === "true";
const token = process.env.RAILWAY_API_TOKEN;

if (!dryRun && !token) {
  console.error("RAILWAY_API_TOKEN is required (account or workspace token).");
  process.exit(1);
}
if (!ownerEmail) {
  console.error("--owner-email is required (DEN_SINGLE_ORG_OWNER_EMAILS).");
  process.exit(1);
}

// ---------------------------------------------------------------- helpers
async function gql(query, variables = {}) {
  if (dryRun) {
    console.log(`[dry-run] ${query.trim().split("\n")[0]} ${JSON.stringify(variables).slice(0, 200)}`);
    return {};
  }
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Railway API error: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

/** Replace ${{secret(n, "alphabet")}} with locally generated values.
 *  Leaves ${{Service.VAR}} / ${{RAILWAY_*}} references intact for Railway to render. */
function resolveTemplateFunctions(value) {
  return value.replace(/\$\{\{\s*secret\((\d+)?\s*(?:,\s*"([^"]*)")?\s*\)\s*\}\}/g, (_m, len, alphabet) => {
    const n = Number(len ?? 32);
    const chars = alphabet ?? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < n; i += 1) out += chars[randomInt(chars.length)];
    return out;
  });
}

function repoFromSource(source) {
  // "https://github.com/owner/repo/tree/branch" -> { repo: "owner/repo", branch }
  const m = source.repo.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?\/?$/);
  if (!m) throw new Error(`Unrecognized repo source: ${source.repo}`);
  return { repo: m[1], branch: m[2] ?? "main" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- main
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const services = Object.values(template.services);
const order = ["mysql", "den-api", "den-web", "worker", "inference"];
services.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

console.log(`Provisioning "${projectName}" with services: ${services.map((s) => s.name).join(", ")}${dryRun ? " (dry run)" : ""}`);

// 1. project
const projectData = await gql(
  `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } } }`,
  { input: { name: projectName, description: "iPolloWork / Openwork Den control plane", defaultEnvironmentName: "production", ...(workspaceId ? { workspaceId } : {}) } },
);
const project = projectData.projectCreate ?? { id: "dry-project", environments: { edges: [{ node: { id: "dry-env", name: "production" } }] } };
const environmentId = project.environments.edges.find((e) => e.node.name === "production")?.node.id ?? project.environments.edges[0].node.id;
console.log(`Project ${project.id} / environment ${environmentId}`);

// 2. services
const created = {};
for (const svc of services) {
  const isRepo = Boolean(svc.source.repo);
  const source = isRepo ? { repo: repoFromSource(svc.source).repo } : { image: svc.source.image };
  const branch = isRepo ? repoFromSource(svc.source).branch : undefined;

  const variables = {};
  for (const [k, v] of Object.entries(svc.variables ?? {})) {
    let value = resolveTemplateFunctions(v.defaultValue ?? "");
    if (k === "DEN_SINGLE_ORG_OWNER_EMAILS" && !value) value = ownerEmail;
    if (!value && v.isOptional) continue; // don't create empty optional vars
    variables[k] = value;
  }

  const data = await gql(
    `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
    { input: { projectId: project.id, environmentId, name: svc.name, icon: svc.icon, source, ...(branch ? { branch } : {}), variables } },
  );
  const serviceId = data.serviceCreate?.id ?? `dry-${svc.name}`;
  created[svc.name] = { id: serviceId, svc };
  console.log(`  service ${svc.name} -> ${serviceId}`);

  // instance settings (start command, healthcheck, root dir, restart policy)
  const input = {};
  if (svc.deploy?.startCommand) input.startCommand = svc.deploy.startCommand;
  if (svc.deploy?.healthcheckPath) input.healthcheckPath = svc.deploy.healthcheckPath;
  if (svc.deploy?.healthcheckTimeout) input.healthcheckTimeout = svc.deploy.healthcheckTimeout;
  if (svc.deploy?.restartPolicyType) input.restartPolicyType = svc.deploy.restartPolicyType;
  if (svc.deploy?.restartPolicyMaxRetries) input.restartPolicyMaxRetries = svc.deploy.restartPolicyMaxRetries;
  if (svc.source.rootDirectory) input.rootDirectory = svc.source.rootDirectory;
  if (Object.keys(input).length) {
    await gql(
      `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
      { serviceId, environmentId, input },
    );
  }

  // volume
  for (const mount of Object.values(svc.volumeMounts ?? {})) {
    await gql(
      `mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`,
      { input: { projectId: project.id, environmentId, serviceId, mountPath: mount.mountPath } },
    );
    console.log(`    volume ${mount.mountPath}`);
  }

  // public domain
  if (svc.networking?.serviceDomains && Object.keys(svc.networking.serviceDomains).length) {
    const port = Number(svc.variables?.PORT?.defaultValue ?? 0) || undefined;
    const d = await gql(
      `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId, ...(port ? { targetPort: port } : {}) } },
    );
    console.log(`    domain ${d.serviceDomainCreate?.domain ?? "(dry)"}`);
  }
}

// 2b. Re-apply every service's variables now that all services and domains
// exist. Railway resolves ${{other-service.VAR}} references against the
// services that exist when the variable is written; a reference to a service
// created later renders as an empty string until the variable is saved again.
for (const svc of services) {
  const { id } = created[svc.name];
  const variables = {};
  for (const [k, v] of Object.entries(svc.variables ?? {})) {
    if (!/\$\{\{\s*[A-Za-z0-9_-]+\./.test(v.defaultValue ?? "")) continue; // only cross-service refs
    variables[k] = v.defaultValue;
  }
  if (!Object.keys(variables).length) continue;
  await gql(
    `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { projectId: project.id, environmentId, serviceId: id, variables, skipDeploys: true } },
  );
  console.log(`  refreshed cross-service references on ${svc.name}: ${Object.keys(variables).join(", ")}`);
}

// 3. deploy in dependency order (mysql first so den-api's retry loop is short)
for (const svc of services) {
  const { id } = created[svc.name];
  await gql(
    `mutation deploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId: id, environmentId },
  );
  console.log(`  deploy triggered: ${svc.name}`);
  if (svc.name === "mysql" && !dryRun) await sleep(15000);
}

// 4. optional: turn the project into a Railway template
if (generateTemplate) {
  const t = await gql(
    `mutation templateGenerate($input: TemplateGenerateInput!) { templateGenerate(input: $input) { id code name } }`,
    { input: { projectId: project.id, environmentId } },
  );
  const tpl = t.templateGenerate ?? { id: "dry", code: "dry-code" };
  console.log(`\nTemplate generated: id=${tpl.id} code=${tpl.code}`);
  console.log(`  Deploy URL : https://railway.com/deploy/${tpl.code}`);
  console.log(`  Composer   : https://railway.com/workspace/templates  (open the template, then:)`);
  console.log(`    - mysql.MYSQL_ROOT_PASSWORD      -> \${{secret(32, "a-zA-Z0-9")}}`);
  console.log(`    - den-api.BETTER_AUTH_SECRET     -> \${{secret(64, "a-zA-Z0-9")}}`);
  console.log(`    - den-api.DEN_DB_ENCRYPTION_KEY  -> \${{secret(64, "a-zA-Z0-9")}}`);
  console.log(`    - worker.OPENWORK_TOKEN / OPENWORK_HOST_TOKEN -> \${{secret(48, "a-zA-Z0-9")}}`);
  console.log(`    - den-api.DEN_SINGLE_ORG_OWNER_EMAILS -> clear the value and mark it required`);
  console.log(`  (exact alphabets are in template/variables.md; templateGenerate copies literal values, so swap them back to functions)`);
}

console.log(`\nDone. Project: https://railway.com/project/${project.id}`);
console.log(`Next: open den-web's public URL, sign in with ${ownerEmail}, then point the desktop app's Cloud URL at it.`);
