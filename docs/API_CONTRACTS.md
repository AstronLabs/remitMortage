# Frontend and backend API contracts

The consumer catalog at `contracts/api/frontend-consumer.json` records the frontend operations and response codes relied on by the UI. Mock examples live in `frontend/__tests__/fixtures/frontend-api-contract-mocks.json`; CI verifies both against the backend's generated OpenAPI document.

When changing an endpoint, first update its OpenAPI annotations in the backend route. Preserve existing response codes and payload fields when possible. For an intentional breaking change, update the consumer entry and mock fixture in the same pull request, and update the frontend caller and its tests. A backend-only change that removes a declared path, method, or response code fails CI.

CI exports OpenAPI from backend source and runs `node scripts/verify-frontend-api-contracts.mjs`. The generated `backend/openapi.json` is a build artifact; the versioned consumer catalog and mock examples are the reviewed contract artifacts.

## Two complementary gates

| Gate | Pins | Fails when |
| --- | --- | --- |
| `scripts/verify-frontend-api-contracts.mjs` | what the UI *relies on* | the backend drops a path, method, response code or required field the frontend consumes |
| `backend/src/__tests__/openapiResponseValidation.test.ts` | what the API *actually returns* | a real response gains an undocumented field, changes a field's type, or answers with an undocumented status |

The first protects the consumer; the second protects the documentation. A
change that adds a response field passes the first and fails the second until
the schema is updated — see `docs/OPENAPI_RESPONSE_VALIDATION.md`.
