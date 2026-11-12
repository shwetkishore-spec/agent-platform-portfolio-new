// Spec quality check for agent readiness.
// Finds every *.openapi.json file in the repo root and checks each operation.
// FAIL = blocks the pull request. WARN = shown, but does not block.
// Runs with plain Node.js. No packages to install.

const fs = require("fs");

const METHODS = ["get", "post", "put", "patch", "delete"];
const files = fs.readdirSync(".").filter(f => f.endsWith(".openapi.json"));

let totalFails = 0;
let totalWarns = 0;
const rows = [];

if (files.length === 0) {
  console.log("No *.openapi.json files found. Nothing to check.");
}

for (const file of files) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    rows.push([file, "-", "FAIL", "File is not valid JSON: " + e.message]);
    totalFails++;
    continue;
  }

  if (!spec.paths) {
    rows.push([file, "-", "FAIL", "No 'paths' section found."]);
    totalFails++;
    continue;
  }

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const fail = (msg) => { rows.push([file, where, "FAIL", msg]); totalFails++; };
      const warn = (msg) => { rows.push([file, where, "WARN", msg]); totalWarns++; };

      // Rule 1: every operation needs a stable name for its agent tool.
      if (!op.operationId) fail("Missing operationId. Agents need a stable tool name.");

      // Rule 2: every operation needs a description an agent can act on.
      const text = [op.summary, op.description].filter(Boolean).join(" ").trim();
      if (!text) fail("Missing summary or description. An agent can't tell when to use this.");
      else if (text.length < 25) fail(`Description "${text}" is too short to guide an agent (minimum 25 characters).`);

      // Rule 3: inputs should be described.
      for (const p of [...(item.parameters || []), ...(op.parameters || [])]) {
        if (p && !p.description) warn(`Parameter "${p.name}" has no description.`);
      }

      // Rule 4: error responses should be documented so agents can recover.
      const codes = Object.keys(op.responses || {});
      if (!codes.some(c => /^[45]/.test(c))) warn("No error responses (4xx/5xx) documented.");
    }
  }
}

// ---- Report ----
const passed = totalFails === 0;
const headline = passed
  ? `✅ Spec quality check passed (${files.length} spec file(s), ${totalWarns} warning(s))`
  : `❌ Spec quality check failed: ${totalFails} problem(s) must be fixed before merging`;

let md = `## ${headline}\n\n`;
if (rows.length) {
  md += "| File | Operation | Result | Details |\n|---|---|---|---|\n";
  for (const r of rows) md += `| ${r.map(x => String(x).replace(/\|/g, "\\|")).join(" | ")} |\n`;
} else if (files.length) {
  md += "Every operation has an operationId, a clear description, described inputs and documented errors.\n";
}

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

process.exit(passed ? 0 : 1);
