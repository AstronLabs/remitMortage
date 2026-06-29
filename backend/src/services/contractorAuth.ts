import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { consumeChallenge } from "./challengeStore.js";

/**
 * Authorization for milestone evidence uploads.
 *
 * Uploads to Pinata/IPFS are gated so that only whitelisted contractors (or the
 * admin) may pin files. A caller proves control of a whitelisted Stellar
 * address by signing a single-use challenge previously issued to that address.
 *
 * The whitelist is sourced from the `CONTRACTOR_WHITELIST` env var (a
 * comma-separated list of Stellar public keys) plus the optional
 * `CONTRACTOR_ADMIN` address. In tests the whitelist can be overridden via
 * `_setWhitelist`.
 */

let whitelistOverride: Set<string> | null = null;

function loadWhitelist(): Set<string> {
  if (whitelistOverride) return whitelistOverride;
  const set = new Set<string>();
  const raw = process.env.CONTRACTOR_WHITELIST || "";
  for (const entry of raw.split(",")) {
    const addr = entry.trim();
    if (addr) set.add(addr);
  }
  const admin = (process.env.CONTRACTOR_ADMIN || "").trim();
  if (admin) set.add(admin);
  return set;
}

/** Returns true if `address` is a whitelisted contractor or the admin. */
export function isWhitelistedContractor(address: string): boolean {
  if (!address) return false;
  return loadWhitelist().has(address);
}

export type UploadAuthResult =
  | { ok: true; address: string }
  | { ok: false; status: number; error: string; message: string };

export interface UploadAuthInput {
  address?: string | null;
  challenge?: string | null;
  signature?: string | null;
}

/**
 * Verify that an upload request is signed by a whitelisted contractor/admin.
 *
 * Steps:
 *  1. All of `address`, `challenge`, `signature` must be present.
 *  2. `address` must be a valid Stellar Ed25519 public key on the whitelist.
 *  3. The challenge must be live and previously issued to `address` (single-use).
 *  4. The signature must verify against the challenge under `address`.
 *
 * Any failure returns a 401 (unauthorized) — except a malformed request body,
 * which returns 400.
 */
export function verifyUploadAuthorization(input: UploadAuthInput): UploadAuthResult {
  const address = (input.address || "").trim();
  const challenge = (input.challenge || "").trim();
  const signature = (input.signature || "").trim();

  if (!address || !challenge || !signature) {
    return {
      ok: false,
      status: 400,
      error: "missing_auth",
      message:
        "Uploads require 'address', 'challenge' and 'signature' (headers or body params).",
    };
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Address is not a valid Stellar public key.",
    };
  }

  if (!isWhitelistedContractor(address)) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Address is not a whitelisted contractor or admin.",
    };
  }

  // Single-use challenge: consume it so a captured signature cannot be replayed.
  const consumed = consumeChallenge(address, challenge);
  if (!consumed.ok) {
    return {
      ok: false,
      status: 401,
      error: "challenge_invalid",
      message: `Challenge ${consumed.reason}.`,
    };
  }

  let valid = false;
  try {
    const keypair = Keypair.fromPublicKey(address);
    const messageBytes = Buffer.from(challenge, "utf8");
    const sigBytes = Buffer.from(signature, "hex");
    valid = keypair.verify(messageBytes, sigBytes);
  } catch {
    valid = false;
  }

  if (!valid) {
    return {
      ok: false,
      status: 401,
      error: "invalid_signature",
      message: "Signature does not match the challenge for this address.",
    };
  }

  return { ok: true, address };
}

/** Test helper: override the in-memory whitelist. Pass null to reset. */
export function _setWhitelist(addresses: string[] | null): void {
  whitelistOverride = addresses ? new Set(addresses) : null;
}
