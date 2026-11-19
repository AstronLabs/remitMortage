// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Device-held signing key for admin sessions (issue #886).
 *
 * The browser half of `backend/src/services/adminDeviceBinding.ts`. It holds a
 * **non-extractable** Ed25519 keypair: `crypto.subtle` will sign with it but
 * will not export the private half, and `structuredClone` into IndexedDB keeps
 * that property. So unlike a session cookie, this key cannot be read out by
 * script, copied by an XSS payload, or lifted from a disk image — which is the
 * whole point. Stealing the cookie no longer gets an attacker a working admin
 * session.
 *
 * Usage:
 *
 * ```ts
 * // once, when the admin opts in:
 * const { deviceId } = await enrollThisDevice("MacBook Pro — Chrome");
 *
 * // on every admin request afterwards:
 * const { headers, body } = await signAdminRequest({
 *   method: "POST",
 *   path: "/api/admin/loans/abc/approve",
 *   payload: { decision: "approve" },
 * });
 * await fetch(path, { method: "POST", credentials: "include", headers, body });
 * ```
 *
 * `signAdminRequest` returns the exact body string it hashed. Send **that**
 * string, not a re-serialisation of the object: the server hashes the bytes it
 * received, so any difference in key order or spacing fails the signature.
 */

/** Must match `PROOF_VERSION` in the backend service. */
const PROOF_VERSION = "v1";

export const DEVICE_ID_HEADER = "x-device-id";
export const DEVICE_TIMESTAMP_HEADER = "x-device-timestamp";
export const DEVICE_NONCE_HEADER = "x-device-nonce";
export const DEVICE_SIGNATURE_HEADER = "x-device-signature";

const DB_NAME = "remitmortgage-admin-device";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_RECORD_ID = "admin-device-key";
const DEVICE_ID_RECORD_ID = "admin-device-id";

export interface DeviceKeyRecord {
  keyPair: CryptoKeyPair;
  deviceId: string | null;
}

/**
 * Where the keypair and device id are kept. The default is IndexedDB; tests
 * (and any non-browser caller) inject an in-memory implementation instead of
 * pulling in a fake-IndexedDB dependency.
 */
export interface DeviceKeyStore {
  get<T>(id: string): Promise<T | null>;
  set(id: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** IndexedDB-backed store. A CryptoKey survives structured cloning intact. */
export const indexedDbStore: DeviceKeyStore = {
  async get<T>(id: string): Promise<T | null> {
    const db = await openDatabase();
    try {
      const value = await transact<T | undefined>(db, "readonly", (store) => store.get(id));
      return value ?? null;
    } finally {
      db.close();
    }
  },
  async set(id: string, value: unknown): Promise<void> {
    const db = await openDatabase();
    try {
      await transact(db, "readwrite", (store) => store.put(value, id));
    } finally {
      db.close();
    }
  },
  async clear(): Promise<void> {
    const db = await openDatabase();
    try {
      await transact(db, "readwrite", (store) => store.clear());
    } finally {
      db.close();
    }
  },
};

/** In-memory store, for tests and for a non-persistent session. */
export function createMemoryStore(): DeviceKeyStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(id: string) {
      return (values.has(id) ? (values.get(id) as T) : null);
    },
    async set(id: string, value: unknown) {
      values.set(id, value);
    },
    async clear() {
      values.clear();
    },
  };
}

let activeStore: DeviceKeyStore = indexedDbStore;

/** Swaps the backing store. Returns the previous one so a test can restore it. */
export function setDeviceKeyStore(store: DeviceKeyStore): DeviceKeyStore {
  const previous = activeStore;
  activeStore = store;
  return previous;
}

export class DeviceKeyUnsupportedError extends Error {
  constructor() {
    super(
      "This browser cannot create a device-bound admin key (Ed25519 WebCrypto is unavailable). Use a current version of Chrome, Edge, Safari or Firefox."
    );
    this.name = "DeviceKeyUnsupportedError";
  }
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new DeviceKeyUnsupportedError();
  return api;
}

/**
 * Returns this device's keypair, generating and persisting one on first call.
 *
 * `extractable: false` is the load-bearing argument — it is what makes the
 * private key unexportable for the lifetime of the key.
 */
export async function getOrCreateDeviceKeyPair(): Promise<CryptoKeyPair> {
  const existing = await activeStore.get<CryptoKeyPair>(KEY_RECORD_ID);
  if (existing?.privateKey) return existing;

  let keyPair: CryptoKeyPair;
  try {
    keyPair = (await subtle().generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
  } catch (error) {
    if (error instanceof DeviceKeyUnsupportedError) throw error;
    throw new DeviceKeyUnsupportedError();
  }

  await activeStore.set(KEY_RECORD_ID, keyPair);
  return keyPair;
}

/** Base64 of the raw 32-byte public key, the format the enrol endpoint takes. */
export async function exportPublicKeyBase64(keyPair: CryptoKeyPair): Promise<string> {
  const raw = await subtle().exportKey("raw", keyPair.publicKey);
  return bytesToBase64(new Uint8Array(raw));
}

export async function getStoredDeviceId(): Promise<string | null> {
  return activeStore.get<string>(DEVICE_ID_RECORD_ID);
}

export async function setStoredDeviceId(deviceId: string): Promise<void> {
  await activeStore.set(DEVICE_ID_RECORD_ID, deviceId);
}

/** Forgets this device's key and id. The admin must enrol again afterwards. */
export async function forgetDeviceKey(): Promise<void> {
  await activeStore.clear();
}

// ---------------------------------------------------------------------------
// Proof construction
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function"
    ? btoa(binary)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(bytes).toString("base64");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of `text` as hex. `""` hashes to the empty-body digest. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/** A fresh, unpredictable nonce. The server requires at least 16 characters. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * The exact string the server rebuilds and verifies. Mirrors
 * `canonicalProofString` in `backend/src/services/adminDeviceBinding.ts`;
 * if the two ever disagree every proof fails closed.
 */
export function canonicalProofString(input: {
  deviceId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    PROOF_VERSION,
    input.deviceId,
    String(input.timestamp),
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
  ].join("|");
}

export interface SignedAdminRequest {
  headers: Record<string, string>;
  /** The exact body string that was hashed — send this, not a re-serialisation. */
  body: string | undefined;
}

/**
 * Signs one admin request with this device's key.
 *
 * @param input.path Request path **without** the query string, as the server
 *                   strips it before verifying.
 * @param input.payload JSON body, or omitted for a body-less request.
 */
export async function signAdminRequest(input: {
  method: string;
  path: string;
  payload?: unknown;
  deviceId?: string;
}): Promise<SignedAdminRequest> {
  const deviceId = input.deviceId ?? (await getStoredDeviceId());
  if (!deviceId) {
    throw new Error("This device is not enrolled for admin access. Enrol it first.");
  }

  const keyPair = await getOrCreateDeviceKeyPair();
  const body = input.payload === undefined ? undefined : JSON.stringify(input.payload);
  const bodyHash = await sha256Hex(body ?? "");
  const timestamp = Date.now();
  const nonce = createNonce();

  const message = new TextEncoder().encode(
    canonicalProofString({
      deviceId,
      timestamp,
      nonce,
      method: input.method,
      path: input.path,
      bodyHash,
    })
  );

  const signature = await subtle().sign({ name: "Ed25519" }, keyPair.privateKey, message);

  const headers: Record<string, string> = {
    [DEVICE_ID_HEADER]: deviceId,
    [DEVICE_TIMESTAMP_HEADER]: String(timestamp),
    [DEVICE_NONCE_HEADER]: nonce,
    [DEVICE_SIGNATURE_HEADER]: bytesToBase64(new Uint8Array(signature)),
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  return { headers, body };
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export interface EnrollmentResult {
  deviceId: string;
  fingerprint: string;
  label: string;
  mode: "off" | "monitor" | "enforce";
}

/**
 * Enrols this device and binds the current admin session to it.
 *
 * The server answers with a re-issued session cookie carrying the key's
 * fingerprint, so the session is bound by the time this resolves.
 */
export async function enrollThisDevice(
  label: string,
  fetchImpl: typeof fetch = fetch
): Promise<EnrollmentResult> {
  const keyPair = await getOrCreateDeviceKeyPair();
  const publicKey = await exportPublicKeyBase64(keyPair);

  const response = await fetchImpl("/api/admin/devices/enroll", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey, label }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Device enrolment failed (${response.status}). ${detail}`.trim());
  }

  const result = (await response.json()) as EnrollmentResult;
  await setStoredDeviceId(result.deviceId);
  return result;
}
