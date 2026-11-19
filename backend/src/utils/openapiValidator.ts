// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Response-shape validation against the published OpenAPI document (issue #879).
 *
 * Real responses drift from the spec silently. A handler gains a field, a
 * number starts arriving as a string, an error grows a `details` object — and
 * nothing fails, because no test compares the two. The published docs and every
 * generated client are then wrong, and the first person to find out is an
 * integrator.
 *
 * {@link validateResponse} closes that loop: given the spec, a method, a path
 * and a status, it resolves the documented schema and reports every way the
 * body disagrees with it.
 *
 * ## Deliberately stricter than OpenAPI
 *
 * In OpenAPI, `additionalProperties` defaults to *true*, so an undocumented
 * field is legal. That default is exactly what lets drift accumulate, so the
 * default here is inverted: an object schema that declares `properties` rejects
 * any key not among them. A response that grows a field must say so in the
 * spec. Pass `allowUndocumented: true` for the OpenAPI-faithful reading.
 *
 * ## What is checked
 *
 * `$ref`, `allOf` / `oneOf` / `anyOf`, `type` (incl. `integer` vs `number`),
 * `nullable`, `required`, `enum`, `pattern`, `format` (`date-time`, `uuid`,
 * `email`), `minimum` / `maximum`, `minLength` / `maxLength`, `items`, and
 * undocumented properties. Unknown keywords are ignored rather than guessed at.
 */

/** A loose OpenAPI document. Only the parts this module reads are named. */
export interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation> | undefined>;
  components?: { schemas?: Record<string, OpenApiSchema> };
  [key: string]: unknown;
}

export interface OpenApiOperation {
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: OpenApiSchema }>;
  [key: string]: unknown;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  [key: string]: unknown;
}

/** One disagreement between a response body and its documented schema. */
export interface ValidationIssue {
  /** JSON path into the body, e.g. `escrow.deposited` or `items[0].id`. */
  path: string;
  /** What is wrong, phrased so a failing test message is actionable. */
  message: string;
  kind:
    | "missing_required"
    | "undocumented_property"
    | "type_mismatch"
    | "format_mismatch"
    | "enum_mismatch"
    | "pattern_mismatch"
    | "range_violation"
    | "length_violation"
    | "no_matching_variant"
    | "undocumented_response"
    | "missing_schema";
}

export interface ValidateOptions {
  /**
   * Allow keys the schema does not declare (the OpenAPI default). Off here,
   * because permitting undocumented fields is what lets drift accumulate.
   */
  allowUndocumented?: boolean;
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Guard against a `$ref` cycle in a hand-written spec. */
const MAX_REF_DEPTH = 32;

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a local `#/...` JSON pointer. Returns null for an external or
 * dangling reference — the caller reports that as a missing schema rather than
 * silently passing the value.
 */
export function resolveRef(spec: OpenApiDocument, ref: string): OpenApiSchema | null {
  if (!ref.startsWith("#/")) return null;

  let current: unknown = spec;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }

  return current && typeof current === "object" ? (current as OpenApiSchema) : null;
}

function deref(
  spec: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  depth = 0
): OpenApiSchema | null {
  if (!schema) return null;
  if (!schema.$ref) return schema;
  if (depth > MAX_REF_DEPTH) return null;
  return deref(spec, resolveRef(spec, schema.$ref) ?? undefined, depth + 1);
}

// ---------------------------------------------------------------------------
// Operation lookup
// ---------------------------------------------------------------------------

/** Turns `/api/borrower/{address}/status` into a matcher. */
function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split("/")
    .map((segment) =>
      /^\{.+\}$/.test(segment)
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

export interface ResolvedOperation {
  /** The spec's path template, e.g. `/api/borrower/{address}/status`. */
  pathTemplate: string;
  method: string;
  operation: OpenApiOperation;
}

/**
 * Finds the operation documenting `method urlPath`.
 *
 * An exact path match wins over a templated one, so `/api/admin/devices`
 * resolves to itself rather than to `/api/admin/devices/{deviceId}/revoke`'s
 * sibling template. `urlPath` may carry a query string; it is ignored.
 */
export function findOperation(
  spec: OpenApiDocument,
  method: string,
  urlPath: string
): ResolvedOperation | null {
  const verb = method.toLowerCase();
  const path = urlPath.split("?")[0];
  const paths = spec.paths ?? {};

  const exact = paths[path]?.[verb];
  if (exact) return { pathTemplate: path, method: verb, operation: exact };

  for (const [template, operations] of Object.entries(paths)) {
    const operation = operations?.[verb];
    if (!operation) continue;
    if (!template.includes("{")) continue;
    if (templateToRegExp(template).test(path)) {
      return { pathTemplate: template, method: verb, operation };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // An unknown `type` is treated as satisfied rather than guessed at.
      return true;
  }
}

/**
 * Every property name an object schema declares, following `$ref` and the
 * combinator branches — so a response merged from `allOf` is not reported as
 * carrying undocumented fields from its own other branch.
 */
function declaredProperties(
  spec: OpenApiDocument,
  schema: OpenApiSchema,
  seen = new Set<OpenApiSchema>()
): Set<string> {
  const names = new Set<string>();
  if (seen.has(schema)) return names;
  seen.add(schema);

  const resolved = deref(spec, schema);
  if (!resolved) return names;
  if (resolved !== schema) {
    for (const name of declaredProperties(spec, resolved, seen)) names.add(name);
    return names;
  }

  for (const name of Object.keys(resolved.properties ?? {})) names.add(name);
  for (const branch of [
    ...(resolved.allOf ?? []),
    ...(resolved.oneOf ?? []),
    ...(resolved.anyOf ?? []),
  ]) {
    for (const name of declaredProperties(spec, branch, seen)) names.add(name);
  }

  return names;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Validates `value` against `schema`, returning every disagreement.
 *
 * An empty array means the value matches the documented shape exactly.
 */
export function validateAgainstSchema(
  spec: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  value: unknown,
  options: ValidateOptions = {},
  path = ""
): ValidationIssue[] {
  if (!schema) return [];

  const resolved = deref(spec, schema);
  if (!resolved) {
    return [
      {
        path,
        kind: "missing_schema",
        message: `schema reference ${schema.$ref ?? "(unknown)"} could not be resolved`,
      },
    ];
  }

  const issues: ValidationIssue[] = [];

  // `nullable: true` (OpenAPI 3.0) is the only way null is acceptable, besides
  // an explicit `type: "null"`.
  if (value === null) {
    const nullableByType = Array.isArray(resolved.type)
      ? resolved.type.includes("null")
      : resolved.type === "null";
    if (resolved.nullable === true || nullableByType) return issues;
    if (resolved.type === undefined && !resolved.allOf && !resolved.oneOf && !resolved.anyOf) {
      return issues;
    }
    return [
      {
        path,
        kind: "type_mismatch",
        message: `is null but the schema does not declare nullable: true`,
      },
    ];
  }

  // ── Combinators ───────────────────────────────────────────────────────
  if (resolved.allOf) {
    for (const branch of resolved.allOf) {
      // Each branch is checked on its own, but the undocumented-property sweep
      // has to see the union of all branches, so it runs once below instead.
      issues.push(
        ...validateAgainstSchema(spec, branch, value, { allowUndocumented: true }, path)
      );
    }
  }

  for (const [keyword, schemas] of [
    ["oneOf", resolved.oneOf],
    ["anyOf", resolved.anyOf],
  ] as const) {
    if (!schemas || schemas.length === 0) continue;
    const matched = schemas.filter(
      (branch) =>
        validateAgainstSchema(spec, branch, value, { allowUndocumented: true }, path).length === 0
    );
    if (matched.length === 0) {
      issues.push({
        path,
        kind: "no_matching_variant",
        message: `does not match any of the ${schemas.length} ${keyword} variants`,
      });
    }
  }

  // ── Type ──────────────────────────────────────────────────────────────
  const types = resolved.type === undefined ? [] : ([] as string[]).concat(resolved.type);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [
      ...issues,
      {
        path,
        kind: "type_mismatch",
        message: `expected type ${types.join(" | ")} but got ${typeOf(value)} (${JSON.stringify(
          value
        )?.slice(0, 80)})`,
      },
    ];
  }

  // ── Scalars ───────────────────────────────────────────────────────────
  if (resolved.enum && !resolved.enum.some((candidate) => candidate === value)) {
    issues.push({
      path,
      kind: "enum_mismatch",
      message: `value ${JSON.stringify(value)} is not one of ${JSON.stringify(resolved.enum)}`,
    });
  }

  if (typeof value === "string") {
    if (resolved.pattern && !new RegExp(resolved.pattern).test(value)) {
      issues.push({
        path,
        kind: "pattern_mismatch",
        message: `value ${JSON.stringify(value)} does not match pattern ${resolved.pattern}`,
      });
    }
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      issues.push({
        path,
        kind: "length_violation",
        message: `length ${value.length} is below minLength ${resolved.minLength}`,
      });
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      issues.push({
        path,
        kind: "length_violation",
        message: `length ${value.length} exceeds maxLength ${resolved.maxLength}`,
      });
    }

    const formatIssue = checkStringFormat(resolved.format, value);
    if (formatIssue) issues.push({ path, kind: "format_mismatch", message: formatIssue });
  }

  if (typeof value === "number") {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      issues.push({
        path,
        kind: "range_violation",
        message: `value ${value} is below minimum ${resolved.minimum}`,
      });
    }
    if (resolved.maximum !== undefined && value > resolved.maximum) {
      issues.push({
        path,
        kind: "range_violation",
        message: `value ${value} exceeds maximum ${resolved.maximum}`,
      });
    }
  }

  // ── Arrays ────────────────────────────────────────────────────────────
  if (Array.isArray(value) && resolved.items) {
    value.forEach((entry, index) => {
      issues.push(
        ...validateAgainstSchema(spec, resolved.items, entry, options, `${path}[${index}]`)
      );
    });
  }

  // ── Objects ───────────────────────────────────────────────────────────
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObject) {
    const record = value as Record<string, unknown>;

    for (const key of resolved.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
        issues.push({
          path: join(path, key),
          kind: "missing_required",
          message: "is required by the schema but absent from the response",
        });
      }
    }

    for (const [key, propertySchema] of Object.entries(resolved.properties ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      issues.push(
        ...validateAgainstSchema(spec, propertySchema, record[key], options, join(path, key))
      );
    }

    if (!options.allowUndocumented) {
      const declared = declaredProperties(spec, resolved);
      // Only sweep when the schema actually describes properties; a bare
      // `type: object` is a deliberate "any shape".
      const describesShape =
        declared.size > 0 ||
        resolved.additionalProperties === false ||
        (resolved.required?.length ?? 0) > 0;
      const extrasAllowed =
        resolved.additionalProperties === true ||
        (typeof resolved.additionalProperties === "object" &&
          resolved.additionalProperties !== null);

      if (describesShape && !extrasAllowed) {
        for (const key of Object.keys(record)) {
          if (declared.has(key)) continue;
          issues.push({
            path: join(path, key),
            kind: "undocumented_property",
            message: `is present in the response but not documented in the schema (value: ${JSON.stringify(
              record[key]
            )?.slice(0, 60)})`,
          });
        }
      }
    }

    if (typeof resolved.additionalProperties === "object" && resolved.additionalProperties !== null) {
      const declared = declaredProperties(spec, resolved);
      for (const [key, entry] of Object.entries(record)) {
        if (declared.has(key)) continue;
        issues.push(
          ...validateAgainstSchema(
            spec,
            resolved.additionalProperties as OpenApiSchema,
            entry,
            options,
            join(path, key)
          )
        );
      }
    }
  }

  return issues;
}

function checkStringFormat(format: string | undefined, value: string): string | null {
  switch (format) {
    case "date-time":
      return DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : `value ${JSON.stringify(value)} is not an RFC 3339 date-time`;
    case "uuid":
      return UUID_RE.test(value) ? null : `value ${JSON.stringify(value)} is not a UUID`;
    case "email":
      return EMAIL_RE.test(value) ? null : `value ${JSON.stringify(value)} is not an email address`;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : `value ${JSON.stringify(value)} is not an RFC 3339 date`;
    default:
      // `binary`, `byte`, vendor formats and anything unrecognised are not
      // second-guessed.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

export interface ResponseToValidate {
  method: string;
  /** Request path as called, with or without a query string. */
  path: string;
  status: number;
  body: unknown;
  /** Defaults to `application/json`. */
  contentType?: string;
}

/**
 * Validates one response against the schema the spec documents for its
 * method, path and status.
 *
 * Reports `undocumented_response` when the operation does not declare that
 * status at all — an undocumented status code is drift too, and the most
 * common kind: a handler grows a 409 that no client knows to expect.
 *
 * A status declared with a `description` but no schema passes with no issues:
 * that is a deliberate "shape not contracted". Use
 * {@link assertResponseIsDocumented} when you want the stronger requirement.
 */
export function validateResponse(
  spec: OpenApiDocument,
  response: ResponseToValidate,
  options: ValidateOptions = {}
): ValidationIssue[] {
  const resolved = findOperation(spec, response.method, response.path);
  if (!resolved) {
    return [
      {
        path: "",
        kind: "undocumented_response",
        message: `${response.method.toUpperCase()} ${response.path} is not documented in the OpenAPI spec`,
      },
    ];
  }

  const responses = resolved.operation.responses ?? {};
  const declared =
    responses[String(response.status)] ??
    responses[`${String(response.status)[0]}XX`] ??
    responses.default;

  if (!declared) {
    return [
      {
        path: "",
        kind: "undocumented_response",
        message: `${response.method.toUpperCase()} ${resolved.pathTemplate} does not document response ${
          response.status
        } (documented: ${Object.keys(responses).join(", ") || "none"})`,
      },
    ];
  }

  const contentType = (response.contentType ?? "application/json").split(";")[0].trim();
  const schema =
    declared.content?.[contentType]?.schema ??
    declared.content?.["application/json"]?.schema;

  if (!schema) return [];

  return validateAgainstSchema(spec, schema, response.body, options);
}

/** Formats issues into a single, readable assertion message. */
export function formatIssues(response: ResponseToValidate, issues: ValidationIssue[]): string {
  const header = `${response.method.toUpperCase()} ${response.path} → ${response.status}: ${
    issues.length
  } schema violation(s) against the OpenAPI spec`;
  const lines = issues.map(
    (issue) => `  • ${issue.path || "(root)"} [${issue.kind}] ${issue.message}`
  );
  return [
    header,
    ...lines,
    "",
    "Either fix the handler, or update the route's @openapi annotation /",
    "components.schemas entry in the same change. See docs/OPENAPI_RESPONSE_VALIDATION.md.",
  ].join("\n");
}

/**
 * Throws when `response` disagrees with its documented schema. Intended for
 * use straight from a test:
 *
 * ```ts
 * const res = await request(app).get("/api/health");
 * assertResponseMatchesSpec(swaggerSpec, {
 *   method: "GET", path: "/api/health", status: res.status, body: res.body,
 * });
 * ```
 */
export function assertResponseMatchesSpec(
  spec: OpenApiDocument,
  response: ResponseToValidate,
  options: ValidateOptions = {}
): void {
  const issues = validateResponse(spec, response, options);
  if (issues.length > 0) throw new Error(formatIssues(response, issues));
}

/**
 * Throws unless the status is documented *with* a JSON schema. The strong form,
 * for endpoints whose payload is part of the published contract.
 */
export function assertResponseIsDocumented(
  spec: OpenApiDocument,
  response: ResponseToValidate
): void {
  const resolved = findOperation(spec, response.method, response.path);
  if (!resolved) {
    throw new Error(
      `${response.method.toUpperCase()} ${response.path} is not documented in the OpenAPI spec`
    );
  }
  const declared = resolved.operation.responses?.[String(response.status)];
  if (!declared) {
    throw new Error(
      `${response.method.toUpperCase()} ${resolved.pathTemplate} does not document response ${
        response.status
      }`
    );
  }
  if (!declared.content?.["application/json"]?.schema) {
    throw new Error(
      `${response.method.toUpperCase()} ${resolved.pathTemplate} documents response ${
        response.status
      } without a JSON schema — add one so its shape is contracted`
    );
  }
  assertResponseMatchesSpec(spec, response);
}
