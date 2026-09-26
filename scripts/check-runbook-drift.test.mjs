import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectRunbookRefs,
  compareRefToTerraform,
  extractRunbookRefs,
  findMarkdownFiles,
  groupRefsByTarget,
  runDriftCheck,
} from "./check-runbook-drift.mjs";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeDocsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runbook-drift-"));
}

// ── extractRunbookRefs ───────────────────────────────────────────────────

test("extractRunbookRefs parses a single valid block with defaults applied", () => {
  const markdown = [
    "# Some Runbook",
    "",
    "The alert topic is `remit-mortgage-cost-anomaly-alerts-production`.",
    "",
    "```runbook-ref",
    "resource: aws_sns_topic.cost_anomaly_alerts",
    "output: cost_anomaly_alerts_topic_name",
    "expect: remit-mortgage-cost-anomaly-alerts-production",
    "```",
    "",
  ].join("\n");

  const { refs, errors } = extractRunbookRefs(markdown, "docs/EXAMPLE.md");

  assert.equal(errors.length, 0);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {
    file: "docs/EXAMPLE.md",
    line: 5,
    resource: "aws_sns_topic.cost_anomaly_alerts",
    output: "cost_anomaly_alerts_topic_name",
    expect: "remit-mortgage-cost-anomaly-alerts-production",
    root: "devops",
    environment: "production",
    note: null,
  });
});

test("extractRunbookRefs honors an explicit root and environment", () => {
  const markdown = [
    "```runbook-ref",
    "resource: aws_apprunner_service.app_blue",
    "root: devops",
    "environment: staging",
    "```",
  ].join("\n");

  const { refs } = extractRunbookRefs(markdown, "docs/EXAMPLE.md");
  assert.equal(refs[0].root, "devops");
  assert.equal(refs[0].environment, "staging");
});

test("extractRunbookRefs parses multiple blocks in one file", () => {
  const markdown = [
    "```runbook-ref",
    "resource: aws_sns_topic.a",
    "```",
    "",
    "some prose in between",
    "",
    "```runbook-ref",
    "resource: aws_sns_topic.b",
    "```",
  ].join("\n");

  const { refs, errors } = extractRunbookRefs(markdown, "docs/EXAMPLE.md");
  assert.equal(errors.length, 0);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].resource, "aws_sns_topic.a");
  assert.equal(refs[1].resource, "aws_sns_topic.b");
});

test("extractRunbookRefs ignores blank lines and # comments inside a block", () => {
  const markdown = [
    "```runbook-ref",
    "# this documents the alert topic",
    "resource: aws_sns_topic.cost_anomaly_alerts",
    "",
    "note: see cost-anomaly.tf",
    "```",
  ].join("\n");

  const { refs, errors } = extractRunbookRefs(markdown, "docs/EXAMPLE.md");
  assert.equal(errors.length, 0);
  assert.equal(refs[0].note, "see cost-anomaly.tf");
});

test("extractRunbookRefs flags a block missing both resource and output", () => {
  const markdown = ["```runbook-ref", "expect: 50", "```"].join("\n");
  const { refs, errors } = extractRunbookRefs(markdown, "docs/BAD.md");
  assert.equal(refs.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /at least one of/i);
});

test("extractRunbookRefs flags an output ref with no expect value", () => {
  const markdown = ["```runbook-ref", "output: cost_anomaly_threshold_usd", "```"].join("\n");
  const { refs, errors } = extractRunbookRefs(markdown, "docs/BAD.md");
  assert.equal(refs.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no "expect" value/i);
});

test("extractRunbookRefs flags a line that isn't key: value", () => {
  const markdown = ["```runbook-ref", "resource: aws_sns_topic.a", "this is not valid", "```"].join("\n");
  const { errors } = extractRunbookRefs(markdown, "docs/BAD.md");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /malformed line/i);
});

test("extractRunbookRefs reports the correct line number for a block later in the file", () => {
  const markdown = ["line 1", "line 2", "line 3", "```runbook-ref", "resource: x", "```"].join("\n");
  const { refs } = extractRunbookRefs(markdown, "docs/EXAMPLE.md");
  assert.equal(refs[0].line, 4);
});

// ── findMarkdownFiles / collectRunbookRefs ────────────────────────────────

test("findMarkdownFiles walks nested directories and skips vendor dirs", () => {
  const dir = makeDocsDir();
  try {
    writeFile(path.join(dir, "a.md"), "# a");
    writeFile(path.join(dir, "sub", "b.md"), "# b");
    writeFile(path.join(dir, "node_modules", "ignored.md"), "# ignored");
    writeFile(path.join(dir, "notes.txt"), "not markdown");

    const found = findMarkdownFiles(dir).map((f) => path.relative(dir, f)).sort();
    assert.deepEqual(found, [path.join("a.md"), path.join("sub", "b.md")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRunbookRefs aggregates refs and errors across multiple files", () => {
  const dir = makeDocsDir();
  try {
    writeFile(path.join(dir, "good.md"), ["```runbook-ref", "resource: aws_sns_topic.a", "```"].join("\n"));
    writeFile(path.join(dir, "bad.md"), ["```runbook-ref", "expect: 1", "```"].join("\n"));

    const { refs, errors } = collectRunbookRefs(dir);
    assert.equal(refs.length, 1);
    assert.equal(errors.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── groupRefsByTarget ──────────────────────────────────────────────────────

test("groupRefsByTarget groups by root+environment and preserves refs", () => {
  const refs = [
    { root: "devops", environment: "production", resource: "a" },
    { root: "devops", environment: "production", resource: "b" },
    { root: "devops", environment: "staging", resource: "c" },
    { root: "devops/terraform", environment: "production", resource: "d" },
  ];

  const groups = groupRefsByTarget(refs);
  assert.equal(groups.length, 3);

  const prod = groups.find((g) => g.root === "devops" && g.environment === "production");
  assert.equal(prod.refs.length, 2);
});

// ── compareRefToTerraform ──────────────────────────────────────────────────

test("compareRefToTerraform returns ok when the output value matches expect", () => {
  const ref = { output: "cost_anomaly_threshold_usd", expect: "50", resource: null, root: "devops", environment: "production" };
  const result = compareRefToTerraform(ref, {
    outputs: { cost_anomaly_threshold_usd: { value: 50 } },
    resourceAddresses: [],
  });
  assert.equal(result.status, "ok");
});

test("compareRefToTerraform flags a value that changed", () => {
  const ref = { output: "cost_anomaly_threshold_usd", expect: "50", resource: null, root: "devops", environment: "production" };
  const result = compareRefToTerraform(ref, {
    outputs: { cost_anomaly_threshold_usd: { value: 250 } },
    resourceAddresses: [],
  });
  assert.equal(result.status, "value_changed");
  assert.match(result.message, /now "250"/);
});

test("compareRefToTerraform flags an output that no longer exists (renamed/removed)", () => {
  const ref = { output: "cost_anomaly_threshold_usd", expect: "50", resource: null, root: "devops", environment: "production" };
  const result = compareRefToTerraform(ref, { outputs: {}, resourceAddresses: [] });
  assert.equal(result.status, "missing_output");
});

test("compareRefToTerraform returns ok when a referenced resource still exists in state", () => {
  const ref = { resource: "aws_sns_topic.cost_anomaly_alerts", output: null, expect: null, root: "devops", environment: "production" };
  const result = compareRefToTerraform(ref, {
    outputs: {},
    resourceAddresses: ["aws_sns_topic.cost_anomaly_alerts", "aws_lambda_function.notifier"],
  });
  assert.equal(result.status, "ok");
});

test("compareRefToTerraform flags a resource address no longer present in state", () => {
  const ref = { resource: "aws_sns_topic.cost_anomaly_alerts", output: null, expect: null, root: "devops", environment: "production" };
  const result = compareRefToTerraform(ref, {
    outputs: {},
    resourceAddresses: ["aws_lambda_function.notifier"],
  });
  assert.equal(result.status, "missing_resource");
  assert.match(result.message, /renamed or removed/);
});

test("compareRefToTerraform checks both resource and output when a ref sets both", () => {
  const ref = {
    resource: "aws_sns_topic.cost_anomaly_alerts",
    output: "cost_anomaly_threshold_usd",
    expect: "50",
    root: "devops",
    environment: "production",
  };
  // Resource still exists, but the output value has drifted — the output
  // check should still fire even though the resource check passed.
  const result = compareRefToTerraform(ref, {
    outputs: { cost_anomaly_threshold_usd: { value: 500 } },
    resourceAddresses: ["aws_sns_topic.cost_anomaly_alerts"],
  });
  assert.equal(result.status, "value_changed");
});

// ── runDriftCheck (acceptance-criteria level) ─────────────────────────────

test("runDriftCheck produces no findings for runbooks with no drift (no false positives)", () => {
  const refs = [
    { resource: "aws_sns_topic.alerts", output: "topic_name", expect: "remit-alerts-production", root: "devops", environment: "production" },
    { resource: "aws_lambda_function.notifier", output: null, expect: null, root: "devops", environment: "production" },
  ];
  const terraformDataByTarget = {
    "devops::production": {
      outputs: { topic_name: { value: "remit-alerts-production" } },
      resourceAddresses: ["aws_sns_topic.alerts", "aws_lambda_function.notifier"],
    },
  };

  assert.deepEqual(runDriftCheck(refs, terraformDataByTarget), []);
});

test("runDriftCheck flags a runbook referencing a since-renamed resource", () => {
  const refs = [
    {
      resource: "aws_apprunner_service.app_blue",
      output: "blue_service_arn",
      expect: "arn:aws:apprunner:us-east-1:111111111111:service/remitmortgage-blue/old-id",
      root: "devops",
      environment: "production",
    },
  ];
  const terraformDataByTarget = {
    "devops::production": {
      // Renamed: the resource address in state is now app_primary, not app_blue.
      outputs: {},
      resourceAddresses: ["aws_apprunner_service.app_primary"],
    },
  };

  const findings = runDriftCheck(refs, terraformDataByTarget);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "missing_resource");
});

test("runDriftCheck reports a distinct finding when a ref's Terraform target couldn't be read", () => {
  const refs = [{ resource: "aws_sns_topic.alerts", output: null, expect: null, root: "devops", environment: "staging" }];
  const findings = runDriftCheck(refs, {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "target_unavailable");
});

test("runDriftCheck evaluates every ref independently, mixing clean and drifted results", () => {
  const refs = [
    { resource: "aws_sns_topic.alerts", output: null, expect: null, root: "devops", environment: "production" },
    { resource: null, output: "threshold_usd", expect: "50", root: "devops", environment: "production" },
  ];
  const terraformDataByTarget = {
    "devops::production": {
      outputs: { threshold_usd: { value: 250 } }, // drifted
      resourceAddresses: ["aws_sns_topic.alerts"], // still present
    },
  };

  const findings = runDriftCheck(refs, terraformDataByTarget);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "value_changed");
});
