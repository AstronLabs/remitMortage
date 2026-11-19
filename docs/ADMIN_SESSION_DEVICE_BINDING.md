# Device Binding for Admin Sessions

Issue #886.

A stolen admin session cookie is the most damaging kind of session theft. It
carries full privilege, it looks exactly like the real admin to every log and
alert, and revoking it requires noticing it first. Device binding changes the
economics: the cookie on its own stops being enough.

## The guarantee

An admin session cookie replayed from a machine other than the one it was
issued to is rejected, and the session is invalidated. The attacker holds the
token and the fingerprint it commits to, but not the key that fingerprint
commits *to* — and that key cannot be exported from the device that made it.

## How it works

```
         ┌─ browser (admin's device) ──────────────┐
         │  Ed25519 keypair, extractable: false    │
         │  private key in IndexedDB, unexportable │
         └─────────────────┬───────────────────────┘
                           │ POST /api/admin/devices/enroll { publicKey }
                           ▼
         ┌─ server ────────────────────────────────┐
         │  store device, fingerprint = SHA-256(pk)│
         │  re-issue session cookie with dbk=<fp>  │
         └─────────────────┬───────────────────────┘
                           │
   every later admin request carries, alongside the cookie:
     x-device-id         the enrolled device
     x-device-timestamp  ms epoch, ±60s of server time
     x-device-nonce      ≥16 chars, single-use
     x-device-signature  Ed25519 over the canonical string below
```

The signed string is built identically on both sides
(`canonicalProofString`):

```
v1|<deviceId>|<timestamp>|<nonce>|<METHOD>|<path>|<sha256(body)>
```

Binding the method, path and body hash into the signature means a captured
proof cannot be lifted onto a different — more damaging — request. The nonce
and timestamp mean it cannot be replayed verbatim.

The checks, in order, each with its own failure reason:

| Reason | Meaning |
| --- | --- |
| `missing_proof` / `malformed_proof` | no signature, or an unusable one |
| `unknown_device` | the device id is not enrolled |
| `device_revoked` | enrolled, then revoked |
| `device_owner_mismatch` | enrolled under a different admin account |
| `device_mismatch` | **the session names a different device — this is the replay case** |
| `stale_proof` | outside the ±60s window; usually clock drift |
| `replayed_proof` | this exact nonce was already spent |
| `invalid_signature` | the signature does not match the request |

## Response contract

On failure the middleware answers `401` **and clears the session cookie**:

```json
{
  "error": "device_binding_failed",
  "reason": "device_mismatch",
  "message": "This session is bound to a different device.",
  "reauthRequired": true
}
```

Clearing the cookie is the "require re-authentication" half of the issue: a
session whose binding failed is not merely refused for this request, it stops
being a session at all, so a thief cannot retry against a softer endpoint.

A session with no `dbk` claim gets `401 device_binding_required` with
`enrollPath` pointing at the enrolment endpoint.

## Enforcement modes

`ADMIN_DEVICE_BINDING`:

| Mode | Behaviour | Default in |
| --- | --- | --- |
| `enforce` | unbound session or failed proof → 401 | production |
| `monitor` | failures are logged and audited, request proceeds | everywhere else |
| `off` | pass-through | — |

`monitor` exists for rollout: turn it on, watch
`remitmortgage_admin_device_binding_failures_total` by `reason` until the
`binding_not_configured` series drains as admins enrol, then switch to
`enforce`.

## What is covered, and what is not

Guarded (`requireBoundDevice()` in `src/index.ts`): every `/api/admin` router —
admin actions, fee waivers, rate sheets, notification templates, admin search,
investor admin, and the device endpoints themselves. Also
`POST /api/admin/impersonate/start` and `/end`, guarded per-route because
`requireAdmin` rather than the outer `authMiddleware` resolves the identity
there.

Deliberately not guarded:

- **`POST /api/admin/devices/enroll`** — it is how a session becomes bound;
  requiring a proof first would make the first enrolment impossible.
- **The static admin API key** (`ADMIN_API_KEY`) — a server-to-server
  credential with no device to bind to. It is gated by `adminIpAllowlist`
  instead.
- **`/api/admin/2fa/*`** — part of the login flow, before a session exists.

The guard is idempotent per request. `index.ts` mounts several routers at
`/api/admin`, so Express runs the guard once per mount until one matches the
path; without the memo the second run would report `replayed_proof` against
the caller's own valid request.

## Operating it

**Enrol a device** (browser, via `frontend/src/lib/admin-device-key.ts`):

```ts
const { deviceId } = await enrollThisDevice("MacBook Pro — Chrome");
```

**Sign each request**:

```ts
const { headers, body } = await signAdminRequest({
  method: "POST",
  path: "/api/admin/loans/abc/approve",
  payload: { decision: "approve" },
});
await fetch(path, { method: "POST", credentials: "include", headers, body });
```

Send the `body` string the helper returns, not a re-serialisation of the
object — the server hashes the bytes it received, so a different key order
fails the signature.

**Lost device**: `POST /api/admin/devices/:deviceId/revoke`. Any session bound
to it fails its next request. Do this from a device you still hold; enrol the
new device first if needed.

**Browser support**: Ed25519 in WebCrypto. Current Chrome, Edge, Safari and
Firefox have it; older builds get `DeviceKeyUnsupportedError` with an
upgrade message. Keep `monitor` mode on until your admin population is known
to be on supported browsers.

## Observability

- `remitmortgage_admin_device_binding_failures_total{reason,mode}` — a rising
  `device_mismatch` or `replayed_proof` rate is session theft in progress, not
  a configuration problem. Alert on those two; the rest are noise.
- Audit actions: `admin.device_binding.enrolled`,
  `admin.device_binding.revoked`, `admin.device_binding.failed` (with reason,
  presented device id, path and user agent).
- `ADMIN_ALERT_EMAIL` is notified on the alarming reasons only (mismatch,
  replay, unknown device, owner mismatch, bad signature), throttled to one
  message per admin per 10 minutes. Clock skew and not-yet-bound sessions stay
  in the audit trail without mailing anyone.

## Storage, and the restart caveat

Enrolments live in memory, alongside `services/totpAuth.ts` and
`services/lockoutService.ts`. The consequence is explicit: **a restart drops
every enrolment**, so each admin re-enrols on next login. That fails closed —
no session stays valid against a forgotten device — but it is a real
operational cost on a frequently-redeployed service. Moving the store to
Postgres is a drop-in change behind the API of
`services/adminDeviceBinding.ts`; nothing outside that module reads the map.

## Tests

| What | Where |
| --- | --- |
| Replay from a second device rejected; legitimate device unaffected | `backend/src/__tests__/adminDeviceBinding.test.ts` |
| Every failure reason, proof reuse, cross-request signature lifting | same file |
| Enforcement modes, API-key exemption, enrolment endpoint | same file |
| Browser key: non-extractability, proof format, enrolment | `frontend/src/lib/__tests__/admin-device-key.test.ts` |

The two suites verify the *same* canonical proof string from opposite sides. If
the client and server formats drift apart, the frontend suite fails rather than
every admin request failing in staging.
