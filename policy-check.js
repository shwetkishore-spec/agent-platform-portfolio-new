// Policy check for infrastructure changes.
// Reads namespace-requests.json and checks every request against the policy below.
// Any FAIL blocks the pull request. Runs with plain Node.js. No packages to install.

const fs = require("fs");

// ---------- The policy (edit these numbers to change the rules) ----------
const POLICY = {
  allowedEnvs: ["dev", "staging", "prod"],
  maxCpuCores: { dev: 4, staging: 8, prod: 16 },
  maxMemoryGi: { dev: 8, staging: 16, prod: 64 },
  maxDevTtlDays: 30
};

// ---------- Helpers ----------
function cpuToCores(v) {
  const s = String(v);
  return s.endsWith("m") ? parseFloat(s) / 1000 : parseFloat(s);
}
function memoryToGi(v) {
  const s = String(v);
  if (s.endsWith("Gi")) return parseFloat(s);
  if (s.endsWith("Mi")) return parseFloat(s) / 1024;
  return NaN;
}

// ---------- Checks ----------
const results = [];
const fail = (who, rule, msg) => results.push({ who, rule, level: "FAIL", msg });

let data;
try {
  data = JSON.parse(fs.readFileSync("namespace-requests.json", "utf8"));
} catch (e) {
  fail("namespace-requests.json", "Valid file", "Could not read the file as JSON: " + e.message);
}

const requests = (data && data.requests) || [];
const seen = new Set();

for (const r of requests) {
  const who = r.name || "(no name)";

  // Rule 1: names follow the naming standard and start with the team name.
  if (!/^[a-z0-9-]{3,40}$/.test(r.name || "")) fail(who, "Naming", "Name must be 3-40 lowercase letters, numbers or dashes.");
  else if (r.team && !r.name.startsWith(r.team + "-")) fail(who, "Naming", `Name must start with the team name "${r.team}-".`);
  if (seen.has(r.name)) fail(who, "Naming", "Another request already uses this name.");
  seen.add(r.name);

  // Rule 2: every namespace has a team, an owner and a cost center.
  for (const field of ["team", "owner", "costCenter"]) {
    if (!r[field]) fail(who, "Ownership", `Missing "${field}". Every namespace needs a team, an owner and a cost center.`);
  }

  // Rule 3: only known environments.
  if (!POLICY.allowedEnvs.includes(r.env)) {
    fail(who, "Environment", `Environment "${r.env}" is not allowed. Use one of: ${POLICY.allowedEnvs.join(", ")}.`);
    continue;
  }

  // Rule 4: CPU and memory stay within the limit for the environment.
  const cpu = cpuToCores(r.cpu), mem = memoryToGi(r.memory);
  if (isNaN(cpu)) fail(who, "Quota", `CPU "${r.cpu}" is not a valid value (examples: 4, 500m).`);
  else if (cpu > POLICY.maxCpuCores[r.env]) fail(who, "Quota", `CPU ${r.cpu} is over the ${r.env} limit of ${POLICY.maxCpuCores[r.env]} cores.`);
  if (isNaN(mem)) fail(who, "Quota", `Memory "${r.memory}" is not a valid value (examples: 8Gi, 512Mi).`);
  else if (mem > POLICY.maxMemoryGi[r.env]) fail(who, "Quota", `Memory ${r.memory} is over the ${r.env} limit of ${POLICY.maxMemoryGi[r.env]}Gi.`);

  // Rule 5: dev namespaces expire, so they don't pile up.
  if (r.env === "dev" && !(r.ttlDays >= 1 && r.ttlDays <= POLICY.maxDevTtlDays)) {
    fail(who, "Expiry", `Dev namespaces need ttlDays between 1 and ${POLICY.maxDevTtlDays}.`);
  }

  // Rule 6: an agent can request prod, but a named human must approve it.
  if (r.env === "prod" && String(r.requestedBy || "").startsWith("agent:") && !r.approvedBy) {
    fail(who, "Agent guardrail", "A prod namespace requested by an agent needs an \"approvedBy\" human.");
  }
}

// ---------- Report ----------
const passed = results.length === 0;
let md = passed
  ? `## ✅ Policy check passed: ${requests.length} namespace request(s) follow every rule\n\n`
  : `## ❌ Policy check failed: ${results.length} violation(s) must be fixed before merging\n\n`;

md += "| Namespace | Rule | Result | Details |\n|---|---|---|---|\n";
if (passed) {
  for (const r of requests) md += `| ${r.name} | All 6 rules | PASS | ${r.env}, ${r.cpu} CPU, ${r.memory} |\n`;
} else {
  for (const x of results) md += `| ${x.who} | ${x.rule} | ${x.level} | ${String(x.msg).replace(/\|/g, "\\|")} |\n`;
}

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

process.exit(passed ? 0 : 1);
