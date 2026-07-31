import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENCRYPTION_CONTEXT = "devin-outpost-vercel/connection/v1";
const SIGNING_CONTEXT = "devin-outpost-vercel/browser-state/v1";

function secret(): string {
  const value = process.env.DEVIN_CONNECTION_SECRET ?? process.env.CRON_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "DEVIN_CONNECTION_SECRET or CRON_SECRET must be at least 16 characters",
    );
  }
  return value;
}

function deriveKey(context: string): Buffer {
  return createHash("sha256").update(context).update("\0").update(secret()).digest();
}

export function encryptConnectionPayload(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(ENCRYPTION_CONTEXT), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptConnectionPayload<T>(envelope: string): T {
  const [version, encodedIv, encodedTag, encodedCiphertext] = envelope.split(".");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("Stored Devin connection has an invalid envelope");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(ENCRYPTION_CONTEXT),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function signBrowserState(stateId: string): string {
  const signature = createHmac("sha256", deriveKey(SIGNING_CONTEXT))
    .update(stateId)
    .digest("base64url");
  return `${stateId}.${signature}`;
}

export function verifyBrowserState(value: string): string | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const stateId = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = createHmac("sha256", deriveKey(SIGNING_CONTEXT))
    .update(stateId)
    .digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  return stateId;
}

export function setupSecretMatches(candidate: string): boolean {
  const expectedValue =
    process.env.DEVIN_CONNECTION_SECRET ?? process.env.CRON_SECRET ?? "";
  const expected = Buffer.from(expectedValue);
  const supplied = Buffer.from(candidate);
  return (
    expected.length >= 16 &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}
