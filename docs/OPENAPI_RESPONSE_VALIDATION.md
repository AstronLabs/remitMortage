# API Response Schema Validation

Issue #879.

Real API responses drift from the published OpenAPI document. A handler gains a
field, a number starts arriving as a string, an error grows a `details` object —
and nothing fails, because nothing compares the two. The docs at `/api-docs`
and every generated client are then quietly wrong, and the first person to find
out is an integrator.

`backend/src/__tests__/openapiResponseValidation.test.ts` closes that loop:
real responses, driven through their routers, checked against the schema the
spec publishes for that method, path and status.

## How it is checked

```ts
const res = await request(app).get(`/api/borrower/${address}/status`);

assertResponseIsDocumented(swaggerSpec, {
  method: "GET",
  path: `/api/borrower/${address}/status`,
  status: res.status,
  body: res.body,
});
```

`assertResponseIsDocumented` (in `backend/src/utils/openapiValidator.ts`)
requires three things and throws a per-field report when any fails:

1. the spec documents the operation (templated paths like
   `/api/borrower/{address}/status` are matched against the concrete URL);
2. it documents **this status code** — an undocumented status is drift too, and
   the most common kind;
3. the status declares a JSON schema, and the body matches it exactly.

Use `assertResponseMatchesSpec` for the weaker form, which accepts a status
documented with a description but no schema.

A failure reads like this:

```
GET /api/borrower/GABC.../status → 200: 2 schema violation(s) against the OpenAPI spec
  • escrow.withdrawn [undocumented_property] is present in the response but not documented in the schema (value: false)
  • escrow.progress [range_violation] value 42.5 exceeds maximum 1

Either fix the handler, or update the route's @openapi annotation /
components.schemas entry in the same change.
```

## Stricter than OpenAPI, on purpose

In OpenAPI, `additionalProperties` defaults to **true**, so an undocumented
field is legal. That default is precisely what lets drift accumulate, so the
validator inverts it: an object schema that declares `properties` rejects any
key not among them.

This is the acceptance criterion of the issue — *a response with an
undocumented field fails the test* — so it is not negotiable per endpoint. If
a payload genuinely has an open shape, say so in the schema with
`additionalProperties: true` (or a schema for the values); a bare
`type: object` with no `properties` is also read as "any shape".

Checked: `$ref`, `allOf` / `oneOf` / `anyOf`, `type` (including `integer` vs
`number`), `nullable`, `required`, `enum`, `pattern`, `format` (`date-time`,
`date`, `uuid`, `email`), `minimum` / `maximum`, `minLength` / `maxLength`,
`items`, and undocumented properties. Unrecognised keywords are ignored rather
than guessed at.

## Error responses are covered too

Error shapes are part of the contract — clients branch on them. Two component
schemas describe the two envelopes this API sends:

| Schema | Shape | Sent by |
| --- | --- | --- |
| `ErrorResponse` | `error` (required), `message`, `statusCode`, `timestamp` | handlers and `middleware/errorHandler.ts` |
| `ValidationErrorResponse` | `error`, `field`, `message` (all required) | `middleware/validate.ts` |

`error` is the stable machine-readable code — see `ERROR_CODES.md`. Because the
validator rejects undocumented fields, adding a field to an error body means
adding it to the envelope schema first.

## Updating a schema on purpose

This is the normal, expected case. The test failing is not a sign you did
something wrong — it is the reminder that the published contract has to change
with the handler.

1. **Change the handler.**
2. **Update the schema in the same commit.** A shared shape lives in
   `backend/src/docs/swagger.ts` under `components.schemas`; a one-off shape
   lives in the route's `@openapi` annotation.
3. **If a status code is new**, add it to that operation's `responses` with a
   `content.application/json.schema`. A status with only a description passes
   `assertResponseMatchesSpec` but fails `assertResponseIsDocumented`.
4. **Run the suite**: `npx jest src/__tests__/openapiResponseValidation.test.ts`.
5. **If the change is breaking for the frontend**, update
   `contracts/api/frontend-consumer.json` and
   `frontend/__tests__/fixtures/frontend-api-contract-mocks.json` too — see
   `docs/API_CONTRACTS.md`. The two gates are complementary: the consumer
   catalog pins what the UI *relies on*, this suite pins what the API
   *actually returns*.

Never widen a schema just to make the test pass. `additionalProperties: true`
on a response that has a known shape, or deleting a `required` entry that is
genuinely always sent, turns the gate off for that endpoint without saying so.

## Adding an endpoint to the suite

Adding an endpoint here is how its payload becomes contracted. Drive the router
with supertest, mock its services, and assert every status it can return —
success *and* errors:

```ts
it("matches the documented 403 shape for another borrower's status", async () => {
  const res = await request(borrowerApp(someoneElse)).get(path);

  expect(res.status).toBe(403);
  assertResponseIsDocumented(spec, { method: "GET", path, status: res.status, body: res.body });
});
```

Currently covered: `/api/health` (200, 503), `/api/verification/check` (200,
400 × 2, 500), `/api/borrower/{address}/status` (200 × 2, 400, 403, 500),
`/api/admin/devices*` (201, 400, 200, 404).

## What the suite found when it was written

The gate is only worth having if it catches things, and it did immediately:

- `BorrowerStatusResponse` documented three fields of `escrow`; the handler
  returned six, plus `pool`, `verificationStatus`, `creditScore` and
  `verification`, and two more fields on `loan`.
- `escrow.progress` was documented as a 0–1 fraction. `computeProgress()`
  returns a 0–100 percentage.
- `RemittanceAnalysis` omitted `standardDeviation` and `selfDealing`, both of
  which the scoring service has always returned.
- `HealthResponse` omitted `components` entirely — the most useful half of the
  health payload.
- `spanMonths` was documented as an integer; it is a `Float` in the database.

All five are fixed in the spec, which is what the issue was asking for: the
documentation now describes what the API does.

## CI

The `API Response Schema Validation` job in `.github/workflows/ci.yml` runs the
suite on every pull request. It also exports the spec with `npm run docs:export`
first, so `backend/openapi.json` and the in-process `swaggerSpec` are known to
agree.
