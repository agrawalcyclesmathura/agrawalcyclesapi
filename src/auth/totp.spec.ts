import { generateSecret, generateToken, verifyToken, base32Decode, base32Encode, otpauthUrl } from "./totp";

describe("TOTP (RFC 6238)", () => {
  it("round-trips base32 encode/decode", () => {
    const buf = Buffer.from("Hello TOTP world!");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("generates a usable base32 secret", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it("verifies a freshly generated token", () => {
    const secret = generateSecret();
    expect(verifyToken(secret, generateToken(secret))).toBe(true);
  });

  it("rejects a wrong token", () => {
    const secret = generateSecret();
    const wrong = generateToken(secret) === "000000" ? "111111" : "000000";
    expect(verifyToken(secret, wrong)).toBe(false);
  });

  it("rejects a token from a different secret", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(verifyToken(a, generateToken(b))).toBe(false);
  });

  it("accepts a token within the drift window and rejects far-off ones", () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyToken(secret, generateToken(secret, now - 30_000))).toBe(true); // -1 step
    expect(verifyToken(secret, generateToken(secret, now + 30_000))).toBe(true); // +1 step
    expect(verifyToken(secret, generateToken(secret, now + 120_000))).toBe(false); // +4 steps
  });

  it("rejects malformed input", () => {
    const secret = generateSecret();
    expect(verifyToken(secret, "abc")).toBe(false);
    expect(verifyToken(secret, "")).toBe(false);
    expect(verifyToken("", "123456")).toBe(false);
  });

  it("builds a valid otpauth URL", () => {
    const url = otpauthUrl("JBSWY3DPEHPK3PXP", "admin@x.com");
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
  });
});
