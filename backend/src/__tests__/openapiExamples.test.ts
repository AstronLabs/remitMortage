// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * OpenAPI example coverage (issue #986).
 *
 * 1. Every operation has a request example (when it takes a body) and a
 *    response example.
 * 2. Every example validates against the schema published beside it.
 * 3. The checker itself fails for an operation added without examples.
 */

import { swaggerSpec } from "../docs/swagger";
import {
  collectOperationExampleIssues,
  listOperations,
  OPERATION_EXAMPLES,
  type LooseSpec,
} from "../docs/openapiExamples";
import {
  validateAgainstSchema,
  type OpenApiDocument,
  type OpenApiSchema,
} from "../utils/openapiValidator";

const spec = swaggerSpec as unknown as LooseSpec & OpenApiDocument;

describe("OpenAPI examples", () => {
  it("covers every operation with at least one response example", () => {
    expect(collectOperationExampleIssues(spec, OPERATION_EXAMPLES)).toEqual([]);
  });

  it("gives every request body an example", () => {
    const missing = listOperations(spec)
      .filter(({ operation }) => {
        const media = operation.requestBody?.content ?? {};
        return Object.keys(media).length > 0 && !Object.values(media).every((m) => m.example !== undefined);
      })
      .map(({ key }) => key);

    expect(missing).toEqual([]);
  });

  it.each(listOperations(spec).map((op) => [op.key, op] as const))(
    "%s examples validate against their schemas",
    (_key, { operation }) => {
      const issues: string[] = [];

      const check = (label: string, media: Record<string, { schema?: OpenApiSchema; example?: unknown }>) => {
        for (const [type, entry] of Object.entries(media)) {
          if (!entry.schema || entry.example === undefined) continue;
          const found = validateAgainstSchema(spec, entry.schema, entry.example);
          if (found.length > 0) issues.push(`${label} ${type}: ${JSON.stringify(found)}`);
        }
      };

      check("request", operation.requestBody?.content ?? {});
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        check(status, response.content ?? {});
      }

      expect(issues).toEqual([]);
    }
  );

  it("fails when a new operation is added without examples", () => {
    const extended: LooseSpec = {
      paths: {
        ...(spec.paths as LooseSpec["paths"]),
        "/api/brand-new": {
          get: {
            responses: {
              "200": {
                description: "New endpoint",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };

    expect(collectOperationExampleIssues(extended, OPERATION_EXAMPLES)).toContain(
      "GET /api/brand-new: no example registered"
    );
  });

  it("fails when a documented response loses its example", () => {
    const broken = JSON.parse(JSON.stringify(spec)) as LooseSpec;
    const media = broken.paths?.["/api/health"]?.get?.responses?.["200"]?.content?.["application/json"];
    expect(media).toBeDefined();
    delete media!.example;

    expect(collectOperationExampleIssues(broken, OPERATION_EXAMPLES)).toContain(
      "GET /api/health 200: application/json response has no example"
    );
  });
});
