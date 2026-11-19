# Adaptive CAPTCHA Challenges

Sign-up (`POST /api/auth/register`) and admin 2FA verification (`POST /api/admin/2fa/verify`) are guarded by `adaptiveCaptcha(action)`. Normal users never see a challenge; one is demanded only when the request source shows risk signals.

## Triggers

| Signal | Default |
| --- | --- |
| `repeated_failures` | 3 failed (4xx) attempts for the action from the source within 10 min |
| `unusual_request_rate` | 30 requests for the action from the source within 10 min |
| `bad_reputation` | source listed in `CAPTCHA_BAD_SOURCES` or flagged via `flagBadReputation` |
| `credential_stuffing_lockout` | source under the adaptive lockout from `services/credentialStuffing.ts` |

Thresholds are env-configurable (see `backend/.env.example`).

## Flow

1. A risky request without a valid token gets `403 captcha_required` with an inline `challenge` (`question` is plain text, so it works with screen readers and needs no third-party script).
2. `POST /api/captcha/solve { challengeId, answer }` returns a signed `token`.
3. Retry the original request with `X-Captcha-Token: <token>` (or `captchaToken` in the body).

Tokens are verified server-side (HMAC-signed), bound to **one action and one source**, expire (5 min) and are **single-use**; replaying one, or using it for another action or from another source, is rejected. Set `CAPTCHA_SECRET` on every instance. State is in-memory like the credential-stuffing detector.

## Accessible alternative and support path

After `CAPTCHA_MAX_SOLVE_ATTEMPTS` wrong answers the response sets `assistedAvailable`. `POST /api/captcha/assisted { challengeId }` then issues a token after `CAPTCHA_ASSISTED_DELAY_MS` (default 60s; before that it returns `429` with `retryAfterMs`). Every challenge response includes `supportContact` (`CAPTCHA_SUPPORT_CONTACT`) so a user is never dead-ended.
