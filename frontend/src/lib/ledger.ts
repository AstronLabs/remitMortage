// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Ledger Nano S / X  ─  Stellar hardware signing layer
 *
 * Wraps @ledgerhq/hw-transport-webhid (primary) with a fallback to
 * @ledgerhq/hw-transport-webusb so the integration works in every
 * Chromium-based browser that supports WebHID or WebUSB.
 *
 * All imports are dynamic so the heavy Ledger bundles are not included
 * in the initial JS payload — they are only loaded when the user
 * explicitly chooses the Ledger option.
 *
 * Stellar BIP-44 derivation path: 44'/148'/<account>'
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default BIP-44 path for the first Stellar account on a Ledger device. */
export const DEFAULT_LEDGER_PATH = "44'/148'/0'";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface for @ledgerhq/hw-app-str default export. */
interface LedgerStr {
  getPublicKey(
    path: string,
    validate?: boolean,
    display?: boolean
  ): Promise<{ publicKey: string; raw: Buffer }>;

  signTransaction(
    path: string,
    transaction: Buffer
  ): Promise<{ signature: Buffer }>;

  signHash(
    path: string,
    hash: Buffer
  ): Promise<{ signature: Buffer }>;
}

/** Minimal interface for a Ledger transport instance. */
interface LedgerTransport {
  close(): Promise<void>;
}

/** Result returned when a Ledger device is successfully opened. */
export interface LedgerConnection {
  transport: LedgerTransport;
  stellar: LedgerStr;
  /** Close the underlying transport and release the device. */
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether the current browser supports WebHID.
 * WebHID is preferred because it requires less permissions boilerplate than
 * WebUSB and works with the latest Ledger firmware.
 */
function supportsWebHID(): boolean {
  return typeof window !== "undefined" && "hid" in navigator;
}

/**
 * Detect whether the current browser supports WebUSB.
 * Used as a fallback when WebHID is unavailable.
 */
function supportsWebUSB(): boolean {
  return typeof window !== "undefined" && "usb" in navigator;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a connection to the Ledger device.
 *
 * Tries WebHID first; falls back to WebUSB if WebHID is not available.
 * Throws a human-readable error when neither transport is supported or when
 * the device cannot be found (e.g. locked, Stellar app not open).
 *
 * The caller is responsible for calling `connection.close()` when the
 * signing operation is complete to release the USB/HID interface.
 */
export async function openLedgerConnection(): Promise<LedgerConnection> {
  if (!supportsWebHID() && !supportsWebUSB()) {
    throw new Error(
      "Your browser does not support WebHID or WebUSB. " +
        "Please use a Chromium-based browser (Chrome, Edge, Brave) to use a Ledger device."
    );
  }

  let transport: LedgerTransport;

  if (supportsWebHID()) {
    // Dynamic import keeps the bundle lean and avoids build-time resolution
    // failures when Ledger support is not installed in the environment.
    let TransportWebHID: { create(): Promise<LedgerTransport> } | null = null;
    try {
      ({ default: TransportWebHID } = await import(/* webpackIgnore: true */ "@ledgerhq/hw-transport-webhid"));
    } catch {
      TransportWebHID = null;
    }

    if (!TransportWebHID) {
      throw new Error("Ledger WebHID transport is not available in this environment.");
    }

    transport = await TransportWebHID.create();
  } else {
    let TransportWebUSB: { create(): Promise<LedgerTransport> } | null = null;
    try {
      ({ default: TransportWebUSB } = await import(/* webpackIgnore: true */ "@ledgerhq/hw-transport-webusb"));
    } catch {
      TransportWebUSB = null;
    }

    if (!TransportWebUSB) {
      throw new Error("Ledger WebUSB transport is not available in this environment.");
    }

    transport = await TransportWebUSB.create();
  }

  let Str: (new (t: LedgerTransport) => LedgerStr) | null = null;
  try {
    ({ default: Str } = await import(/* webpackIgnore: true */ "@ledgerhq/hw-app-str"));
  } catch {
    Str = null;
  }

  if (!Str) {
    throw new Error("Ledger app support is not available in this environment.");
  }

  const stellar = new (Str as unknown as new (t: LedgerTransport) => LedgerStr)(transport);

  return {
    transport,
    stellar,
    close: () => transport.close(),
  };
}

/**
 * Retrieve the Stellar public key for the given BIP-44 derivation path.
 *
 * @param path       BIP-44 path, defaults to `DEFAULT_LEDGER_PATH`.
 * @param displayOnDevice  When `true` the address is shown on the Ledger
 *                          screen for the user to verify.
 *
 * @returns The base-32 Stellar public key (G-address).
 */
export async function getLedgerPublicKey(
  path = DEFAULT_LEDGER_PATH,
  displayOnDevice = false
): Promise<{ publicKey: string; connection: LedgerConnection }> {
  const connection = await openLedgerConnection();

  try {
    const result = await connection.stellar.getPublicKey(
      path,
      displayOnDevice,
      displayOnDevice
    );
    return { publicKey: result.publicKey, connection };
  } catch (err) {
    await connection.close();
    throw wrapLedgerError(err);
  }
}

/**
 * Sign a Stellar transaction XDR with the Ledger device.
 *
 * The function accepts the assembled XDR string produced by the Soroban
 * assembleTransaction step, deserialises it into a raw Buffer for the
 * Ledger hw-app-str, gets the signature, re-attaches it to the transaction
 * envelope, and returns the signed XDR ready for submission.
 *
 * @param txXdr   Base-64 encoded transaction XDR.
 * @param path    BIP-44 derivation path, defaults to `DEFAULT_LEDGER_PATH`.
 */
export async function signTransactionWithLedger(
  txXdr: string,
  path = DEFAULT_LEDGER_PATH
): Promise<string> {
  // Import stellar-sdk lazily (it's already in the main bundle but we keep
  // the dependency explicit here so this module stays self-contained).
  const { TransactionBuilder, Transaction, FeeBumpTransaction } = await import(
    "@stellar/stellar-sdk"
  );

  const connection = await openLedgerConnection();

  try {
    // Deserialise the XDR to determine the network passphrase and build the
    // bytes that the Ledger device needs to hash-and-sign.
    const networkPassphrase =
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
      "Test SDF Network ; September 2015";

    const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);

    if (tx instanceof FeeBumpTransaction) {
      throw new Error("Fee-bump transactions are not supported via Ledger.");
    }

    // Compute the transaction hash bytes (32-byte SHA-256 of network hash +
    // tx bytes) — this is what Ledger actually signs.
    const txHashBuffer = Buffer.from(
      (tx as InstanceType<typeof Transaction>).hash()
    );

    // The hw-app-str `signTransaction` method expects the raw XDR bytes of
    // the transaction envelope, not the hash.  We pass the pre-serialised
    // buffer so Ledger can independently hash and verify on-device.
    const txBuffer = Buffer.from(txXdr, "base64");

    const { signature } = await connection.stellar.signTransaction(
      path,
      txBuffer
    );

    // Attach the signature to the transaction.
    const keypairLike = {
      publicKey: (): Buffer => {
        // Extract the 32-byte raw public key from the result of getPublicKey.
        // hw-app-str returns a G-address string; use stellar-sdk StrKey to decode.
        return Buffer.from([0]); // placeholder — replaced below
      },
      sign: (_: Buffer): Buffer => signature,
    };

    // Re-parse the XDR, add the decorator signature, and re-serialise.
    // stellar-sdk v14 Transaction.addDecoratedSignature expects a
    // DecoratedSignature xdr type.  We use the lower-level API instead.
    const { xdr: stellarXdr, StrKey } = await import("@stellar/stellar-sdk");

    // Recover the signer's hint from the path by fetching the public key.
    // This is a quick operation (no screen prompt) done on the already-open transport.
    const { publicKey: signerPublicKeyStr } =
      await connection.stellar.getPublicKey(path, false, false);

    const signerRawKey = StrKey.decodeEd25519PublicKey(signerPublicKeyStr);
    const hint = Buffer.from(signerRawKey).slice(-4); // last 4 bytes

    const decoratedSig = new stellarXdr.DecoratedSignature({
      hint: hint,
      signature: signature,
    });

    (tx as InstanceType<typeof Transaction>).signatures.push(decoratedSig);

    return (tx as InstanceType<typeof Transaction>).toEnvelope().toXDR("base64");
  } catch (err) {
    throw wrapLedgerError(err);
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Convert raw Ledger / transport errors into user-readable messages.
 */
function wrapLedgerError(err: unknown): Error {
  if (err instanceof Error) {
    const msg = err.message;

    // Device locked or Stellar app not open.
    if (msg.includes("0x6e00") || msg.includes("0x6700")) {
      return new Error(
        "Ledger device is locked or the Stellar app is not open. " +
          "Unlock your device and open the Stellar app, then try again."
      );
    }

    // User rejected the operation on the device.
    if (msg.includes("0x6985") || msg.toLowerCase().includes("denied")) {
      return new Error("Transaction was rejected on the Ledger device.");
    }

    // No device found / permission denied by browser.
    if (
      msg.toLowerCase().includes("no device selected") ||
      msg.toLowerCase().includes("access denied")
    ) {
      return new Error(
        "No Ledger device selected. " +
          "Make sure the device is plugged in and click 'Connect' again."
      );
    }

    return err;
  }

  return new Error("An unknown Ledger error occurred.");
}
