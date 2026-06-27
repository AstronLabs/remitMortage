import { encrypt, decrypt } from "../utils/crypto";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("AES-256-GCM encryption utilities", () => {
  it("encrypts and decrypts a string round-trip", () => {
    const plaintext = "123-45-6789";
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(typeof ciphertext).toBe("string");

    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts different plaintexts to different ciphertexts", () => {
    const a = encrypt("hello");
    const b = encrypt("hello");

    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("hello");
    expect(decrypt(b)).toBe("hello");
  });

  it("handles empty strings", () => {
    const ciphertext = encrypt("");
    expect(decrypt(ciphertext)).toBe("");
  });

  it("handles Unicode content", () => {
    const plaintext = "日本語テスト ¥1000";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("handles long strings", () => {
    const plaintext = "A".repeat(10_000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("throws when ENCRYPTION_KEY is not set", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });

  it("throws when ENCRYPTION_KEY has wrong length", () => {
    process.env.ENCRYPTION_KEY = "short-key";
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });

  it("decrypts tampered ciphertext", () => {
    const ciphertext = encrypt("secret");
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decrypt(tampered.toString("base64"))).toThrow();
  });
});
