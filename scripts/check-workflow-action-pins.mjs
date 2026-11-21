#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve relative to this script so it works from any working directory.
const workflowDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.github/workflows");
const trustedOwners = new Set([
  "actions", "anchore", "aquasecurity", "aws-actions", "codecov", "dawidd6",
  "dependabot", "docker", "dtolnay", "github", "hashicorp", "infracost",
  "peter-evans", "sigstore", "snyk", "softprops", "swatinem",
]);
const errors = [];

for (const name of (await readdir(workflowDir)).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))) {
  const file = path.join(workflowDir, name);
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/);
    if (!match) return;
    const [, reference, comment = ""] = match;
    if (reference.startsWith("./") || reference.startsWith("docker://")) return;
    const at = reference.lastIndexOf("@");
    if (at < 1) {
      errors.push(`${file}:${index + 1}: action must be pinned to a commit SHA: ${reference}`);
      return;
    }
    const owner = reference.slice(0, at).split("/")[0];
    const sha = reference.slice(at + 1);
    if (!trustedOwners.has(owner)) errors.push(`${file}:${index + 1}: action owner is not allowlisted: ${owner}`);
    if (!/^[a-f0-9]{40}$/.test(sha)) errors.push(`${file}:${index + 1}: action ref must be a full 40-character SHA: ${reference}`);
    if (!comment.trim()) errors.push(`${file}:${index + 1}: pinned action must document its release tag in a comment`);
  });
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("All workflow actions are pinned to SHAs from trusted owners.");
