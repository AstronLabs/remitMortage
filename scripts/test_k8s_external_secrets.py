# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
"""Structural checks for the External Secrets Operator Kubernetes setup."""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parent.parent
K8S = ROOT / "devops/k8s"
ESO = K8S / "external-secrets"


def load_documents(path):
    with path.open(encoding="utf-8") as manifest:
        return [doc for doc in yaml.safe_load_all(manifest) if isinstance(doc, dict)]


def documents_under(directory):
    return [
        doc
        for path in sorted(directory.rglob("*.yaml"))
        for doc in load_documents(path)
    ]


class ExternalSecretsManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.external_secrets = [
            doc
            for path in sorted(ESO.glob("*external-secret*.yaml"))
            for doc in load_documents(path)
            if doc.get("kind") == "ExternalSecret"
        ]
        cls.by_kind_name = {
            (doc.get("kind"), doc.get("metadata", {}).get("name")): doc
            for doc in documents_under(K8S)
        }
        cls.target_keys = {
            external_secret["spec"]["target"]["name"]: {
                entry["secretKey"] for entry in external_secret["spec"]["data"]
            }
            for external_secret in cls.external_secrets
        }
        with (ESO / "helm-values.yaml").open(encoding="utf-8") as values:
            cls.helm_values = yaml.safe_load(values)

    def test_operator_is_limited_to_the_application_namespace(self):
        values = self.helm_values
        self.assertEqual(values["scopedNamespace"], "remitmortgage")
        self.assertTrue(values["scopedRBAC"])
        self.assertFalse(values["processClusterStore"])
        self.assertFalse(values["processClusterExternalSecret"])
        self.assertFalse(values["processClusterPushSecret"])
        self.assertFalse(values["processClusterGenerator"])
        self.assertFalse(values["rbac"]["serviceAccountTokenCreate"])
        self.assertIn(
            "<AWS_ACCOUNT_ID>",
            values["serviceAccount"]["annotations"]["eks.amazonaws.com/role-arn"],
        )

    def test_rbac_is_namespace_scoped_and_token_request_is_name_limited(self):
        operator_docs = documents_under(ESO)
        self.assertFalse(
            any(doc.get("kind") in {"ClusterRole", "ClusterRoleBinding"} for doc in operator_docs)
        )

        token_role = self.by_kind_name[("Role", "external-secrets-token-request")]
        self.assertEqual(token_role["metadata"]["namespace"], "remitmortgage")
        self.assertEqual(
            token_role["rules"],
            [
                {
                    "apiGroups": [""],
                    "resources": ["serviceaccounts/token"],
                    "resourceNames": ["external-secrets"],
                    "verbs": ["create"],
                }
            ],
        )

        reloader_role = self.by_kind_name[("Role", "remitmortgage-secret-reloader")]
        self.assertEqual(reloader_role["metadata"]["namespace"], "remitmortgage")
        self.assertEqual(
            {resource for rule in reloader_role["rules"] for resource in rule["resources"]},
            {"secrets", "deployments", "events"},
        )
        binding = self.by_kind_name[("RoleBinding", "remitmortgage-secret-reloader")]
        self.assertEqual(binding["roleRef"]["kind"], "Role")
        self.assertEqual(binding["metadata"]["namespace"], "remitmortgage")

    def test_external_secrets_refresh_from_placeholders_without_committing_values(self):
        expected_targets = {
            "remitmortgage-backend-secrets",
            "production-readonly-secrets",
            "staging-db-secrets",
        }
        actual_targets = set()
        target_keys = {}
        for external_secret in self.external_secrets:
            spec = external_secret["spec"]
            target = spec["target"]
            actual_targets.add(target["name"])
            target_keys[target["name"]] = {entry["secretKey"] for entry in spec["data"]}
            self.assertEqual(spec["refreshInterval"], "5m")
            self.assertEqual(spec["refreshPolicy"], "Periodic")
            self.assertEqual(target["creationPolicy"], "Owner")
            self.assertEqual(target["deletionPolicy"], "Retain")
            self.assertEqual(spec["secretStoreRef"]["kind"], "SecretStore")
            for entry in spec["data"]:
                self.assertIn("key", entry["remoteRef"])
                self.assertIn("property", entry["remoteRef"])
                if external_secret["metadata"]["name"] != "production-readonly-secrets":
                    self.assertIn("REPLACE_WITH_", entry["remoteRef"]["key"])
        self.assertEqual(actual_targets, expected_targets)

        backend = next(
            secret
            for secret in self.external_secrets
            if secret["metadata"]["name"] == "remitmortgage-backend-secrets"
        )
        backend_keys = {entry["secretKey"] for entry in backend["spec"]["data"]}
        self.assertEqual(
            backend_keys,
            {
                "database-url",
                "redis-url",
                "redis-cluster-nodes",
                "otel-exporter-otlp-endpoint",
            },
        )
        backend_properties = {
            entry["secretKey"]: entry["remoteRef"]["property"]
            for entry in backend["spec"]["data"]
        }
        self.assertEqual(
            backend_properties,
            {
                "database-url": "databaseUrl",
                "redis-url": "redisUrl",
                "redis-cluster-nodes": "redisClusterNodes",
                "otel-exporter-otlp-endpoint": "otelExporterOtlpEndpoint",
            },
        )

        staging_file_targets = {
            doc["spec"]["target"]["name"]
            for doc in load_documents(ESO / "staging-external-secrets.yaml")
        }
        self.assertEqual(staging_file_targets, {"production-readonly-secrets", "staging-db-secrets"})

        store = self.by_kind_name[("SecretStore", "remitmortgage-aws-secrets")]
        provider = store["spec"]["provider"]["aws"]
        self.assertEqual(provider["service"], "SecretsManager")
        self.assertEqual(provider["region"], "REPLACE_WITH_AWS_REGION")
        self.assertEqual(
            provider["auth"]["jwt"]["serviceAccountRef"]["name"], "external-secrets"
        )

        secret_manifests = [
            doc
            for doc in documents_under(K8S)
            if doc.get("kind") == "Secret"
        ]
        self.assertEqual(secret_manifests, [], "Secret values must be synced, not committed")

    def test_all_secret_consumers_reference_synced_targets(self):
        targets = {
            external_secret["spec"]["target"]["name"]
            for external_secret in self.external_secrets
        }
        expected_consumers = {
            "remitmortgage-backend-secrets",
            "production-readonly-secrets",
            "staging-db-secrets",
        }
        self.assertEqual(expected_consumers, targets)

        backend = self.by_kind_name[("Deployment", "remitmortgage-backend")]
        canary = self.by_kind_name[("Deployment", "remitmortgage-backend-canary")]
        for deployment in (backend, canary):
            self.assertEqual(deployment["metadata"]["namespace"], "remitmortgage")
            self.assertEqual(
                deployment["metadata"]["annotations"]["secret.reloader.stakater.com/reload"],
                "remitmortgage-backend-secrets",
            )
            refs = {
                (env["valueFrom"]["secretKeyRef"]["name"], env["valueFrom"]["secretKeyRef"]["key"])
                for container in deployment["spec"]["template"]["spec"]["containers"]
                for env in container.get("env", [])
                if "secretKeyRef" in env.get("valueFrom", {})
            }
            self.assertTrue(all(name in targets for name, _ in refs))
            for name, key in refs:
                self.assertIn(key, self.target_keys[name])

        seed = self.by_kind_name[("CronJob", "anonymized-staging-seed")]
        seed_refs = {
            env["valueFrom"]["secretKeyRef"]["name"]
            for env in seed["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
            if "secretKeyRef" in env.get("valueFrom", {})
        }
        self.assertEqual(
            seed_refs,
            {"production-readonly-secrets", "staging-db-secrets"},
        )

    def test_reloader_is_pinned_and_runs_in_the_target_namespace(self):
        reloader = self.by_kind_name[("Deployment", "remitmortgage-secret-reloader")]
        container = reloader["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(reloader["metadata"]["namespace"], "remitmortgage")
        namespace = self.by_kind_name[("Namespace", "remitmortgage")]
        self.assertEqual(namespace["metadata"]["labels"]["app.kubernetes.io/name"], "remitmortgage")
        self.assertEqual(
            container["args"],
            ["--namespace-selector=app.kubernetes.io/name=remitmortgage"],
        )
        self.assertEqual(container["image"], "ghcr.io/stakater/reloader:v1.4.14")
        self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertNotIn("ClusterRole", {doc.get("kind") for doc in documents_under(ESO)})


if __name__ == "__main__":
    unittest.main()
