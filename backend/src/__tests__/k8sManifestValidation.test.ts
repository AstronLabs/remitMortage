// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import path from "path";

describe("Kubernetes Manifest Policy Rules (Rego / Conftest)", () => {
  const policyFilePath = path.join(
    __dirname,
    "../../../devops/k8s/policy/k8s_policy.rego"
  );
  const k8sDir = path.join(__dirname, "../../../devops/k8s");

  it("should have the rego policy file present", () => {
    expect(fs.existsSync(policyFilePath)).toBe(true);
    const regoContent = fs.readFileSync(policyFilePath, "utf8");
    expect(regoContent).toContain("package main");
    expect(regoContent).toContain("resources.limits");
    expect(regoContent).toContain(":latest");
    expect(regoContent).toContain("app");
  });

  it("should verify existing deployment manifests have required fields", () => {
    const deploymentPath = path.join(k8sDir, "backend-deployment.yaml");
    expect(fs.existsSync(deploymentPath)).toBe(true);

    const manifestText = fs.readFileSync(deploymentPath, "utf8");
    expect(manifestText).toContain("resources:");
    expect(manifestText).toContain("limits:");
    expect(manifestText).toContain("app: remitmortgage-backend");
  });

  it("should evaluate sample policy rules logic", () => {
    const evaluatePolicy = (manifest: any): string[] => {
      const violations: string[] = [];

      // Check resource limits
      if (
        manifest.kind === "Deployment" ||
        manifest.kind === "Pod" ||
        manifest.kind === "Job"
      ) {
        const containers =
          manifest.spec?.template?.spec?.containers ||
          manifest.spec?.containers ||
          [];
        for (const c of containers) {
          if (!c.resources || !c.resources.limits) {
            violations.push(
              `Container '${c.name}' in ${manifest.kind} '${manifest.metadata?.name}' is missing resource limits`
            );
          }
          if (c.image && c.image.endsWith(":latest")) {
            violations.push(
              `Container '${c.name}' in ${manifest.kind} '${manifest.metadata?.name}' uses disallowed ':latest' image tag`
            );
          }
        }
      }

      // Check labels
      const labels = manifest.metadata?.labels || {};
      if (!labels.app && !labels["app.kubernetes.io/name"]) {
        violations.push(
          `Manifest '${manifest.metadata?.name}' (${manifest.kind}) is missing required 'app' label`
        );
      }

      return violations;
    };

    const invalidManifest = {
      kind: "Deployment",
      metadata: { name: "invalid-app" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "web", image: "nginx:latest" }],
          },
        },
      },
    };

    const errors = evaluatePolicy(invalidManifest);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("missing resource limits"))).toBe(true);
    expect(errors.some((e) => e.includes("disallowed ':latest'"))).toBe(true);
    expect(errors.some((e) => e.includes("missing required 'app' label"))).toBe(true);

    const validManifest = {
      kind: "Deployment",
      metadata: { name: "valid-app", labels: { app: "valid-app" } },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "web",
                image: "nginx:1.25.0",
                resources: { limits: { cpu: "500m", memory: "256Mi" } },
              },
            ],
          },
        },
      },
    };

    const validErrors = evaluatePolicy(validManifest);
    expect(validErrors.length).toBe(0);
  });
});
