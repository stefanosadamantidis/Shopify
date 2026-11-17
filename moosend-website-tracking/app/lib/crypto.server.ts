import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not set. Generate a 32-byte base64 key (see .env.example).",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

/** AES-256-GCM encryption. Output format: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Unsupported encrypted payload format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encrypt(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decrypt(value) : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deterministic keyed hash used to look up emails without storing plaintext. */
export function hashEmail(email: string): string {
  return createHmac("sha256", getKey())
    .update(`email:${normalizeEmail(email)}`)
    .digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Show only the last 4 characters of a secret, for UI display. */
export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  const tail = secret.slice(-4);
  return `••••••••${tail}`;
}
