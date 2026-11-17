import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hashEmail, maskSecret } from "../app/lib/crypto.server";

describe("crypto helpers", () => {
  it("round-trips AES-256-GCM encryption with random IVs", () => {
    const a = encrypt("moosend-secret");
    const b = encrypt("moosend-secret");
    expect(a).not.toEqual(b);
    expect(a).not.toContain("moosend-secret");
    expect(decrypt(a)).toBe("moosend-secret");
  });

  it("detects tampering", () => {
    const parts = encrypt("value").split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("hashes emails case-insensitively without revealing them", () => {
    expect(hashEmail(" Buyer@Example.com ")).toBe(hashEmail("buyer@example.com"));
    expect(hashEmail("buyer@example.com")).not.toContain("buyer");
  });

  it("masks secrets for display", () => {
    expect(maskSecret("abcdef123456")).toBe("••••••••3456");
    expect(maskSecret(null)).toBeNull();
  });
});
