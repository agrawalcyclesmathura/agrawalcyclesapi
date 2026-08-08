import * as crypto from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30s step) implemented with node:crypto —
 * no external dependency. Compatible with Google Authenticator / Authy / 1Password.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Random base32 secret (default 20 bytes → 160-bit, RFC-recommended). */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (high word is 0 for any realistic timestamp).
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

/** Current TOTP for a base32 secret (used in tests / server-side generation). */
export function generateToken(secretBase32: string, forTime = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(forTime / 1000 / 30));
}

/** Verify a token allowing ±`window` 30s steps for clock drift. Constant-time compare. */
export function verifyToken(secretBase32: string, token: string, window = 1): boolean {
  if (!secretBase32 || !/^\d{6}$/.test(token?.trim() ?? "")) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const candidate = token.trim();
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, counter + i);
    if (expected.length === candidate.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
      return true;
    }
  }
  return false;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = "Agrawal Cycles"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
