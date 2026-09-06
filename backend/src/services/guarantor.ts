/**
 * Guarantor / co-signer authorization helpers.
 *
 * Authorization mechanism
 * ───────────────────────
 * A guarantor proves explicit acceptance by producing an Ed25519 signature
 * over a deterministic loan commitment string.  This follows the same pattern
 * already used for DID proofs in services/did.ts:
 *   - verifyEd25519Signature (nacl.sign.detached.verify)
 *   - StrKey.decodeEd25519PublicKey to extract the raw 32-byte public key
 *
 * Commitment string format (UTF-8 encoded before signing):
 *   "guarantee:<borrowerAddress>:<principal>:<loanId>"
 *
 * Both the borrower address and loanId are embedded so the signature is
 * scoped to exactly one loan and cannot be replayed on another loan or for
 * a different borrower.
 *
 * On-chain limitation
 * ────────────────────
 * The Soroban lending-pool contract's request_loan function requires only
 * borrower.require_auth() and stores no guarantor field in LoanRecord.
 * mark_default seizes the *borrower's* escrow collateral only.  There is
 * no on-chain guarantor authorization or liability mechanism in the current
 * contracts.  Guarantor authorization and liability notification are
 * therefore enforced off-chain by this service.
 *
 * When a `request_loan_with_guarantor` entry point is added to the contract
 * (storing guarantor: Option<Address> in LoanRecord and calling
 * guarantor.require_auth()), the guarantorAddress stored in the DB can be
 * passed through to that call.
 */

import nacl from "tweetnacl";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * Builds the deterministic UTF-8 commitment string that the guarantor must
 * sign to authorize liability on this loan.
 *
 * The string embeds borrowerAddress, principal, and loanId so the signature
 * is scoped to a specific loan and cannot be replayed elsewhere.
 */
export function buildGuarantorCommitment(
  borrowerAddress: string,
  principal: string | number,
  loanId: string
): string {
  return `guarantee:${borrowerAddress}:${principal}:${loanId}`;
}

/**
 * Verifies that `signature` (hex-encoded Ed25519 signature) was produced by
 * the private key corresponding to `guarantorAddress` (Stellar G-address)
 * over the canonical commitment string for this loan.
 *
 * Returns true only when:
 *   1. guarantorAddress is a syntactically valid Stellar G-address.
 *   2. The raw Ed25519 public key decoded from the address verifies the
 *      signature over the commitment string.
 *
 * All errors (bad address, bad signature encoding, wrong key) return false.
 */
export function verifyStellarGuarantorSignature(
  guarantorAddress: string,
  borrowerAddress: string,
  principal: string | number,
  loanId: string,
  signatureHex: string
): boolean {
  try {
    // Decode the Ed25519 public key bytes from the Stellar G-address.
    // StrKey.decodeEd25519PublicKey throws on any invalid address.
    const publicKeyBytes = StrKey.decodeEd25519PublicKey(guarantorAddress);

    const commitment = buildGuarantorCommitment(borrowerAddress, principal, loanId);
    const messageBytes = new TextEncoder().encode(commitment);
    const sigBytes = Buffer.from(signatureHex, "hex");

    if (sigBytes.length !== 64) return false;

    return nacl.sign.detached.verify(
      messageBytes,
      new Uint8Array(sigBytes),
      publicKeyBytes
    );
  } catch {
    return false;
  }
}
