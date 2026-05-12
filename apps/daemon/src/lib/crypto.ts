import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "./env";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  if (!env.encryptionKey) {
    // Dev fallback: derive from a static phrase. User should set ENCRYPTION_KEY_HEX.
    return scryptSync("nara-bot-dashboard-dev", "salt", 32);
  }
  if (env.encryptionKey.length !== 64) {
    throw new Error("ENCRYPTION_KEY_HEX must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(env.encryptionKey, "hex");
}

export function encryptString(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptString(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}
