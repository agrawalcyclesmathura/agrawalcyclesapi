/**
 * Fail-fast environment validation. Called at the very start of bootstrap so a
 * misconfigured container crashes immediately with an actionable message rather
 * than failing deep inside a request later.
 */
const REQUIRED = ["DATABASE_URL", "REDIS_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const;

const INSECURE_DEFAULTS = ["change-me-access-secret", "change-me-refresh-secret"];

export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED.filter((k) => !env[k] || String(env[k]).trim() === "");
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  const isProd = env.NODE_ENV === "production";
  if (isProd) {
    const weak = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].filter(
      (s) => s && (INSECURE_DEFAULTS.includes(s) || s.length < 24),
    );
    if (weak.length) {
      throw new Error(
        "Refusing to start in production with weak/default JWT secrets. " +
          "Set strong, unique JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (≥24 chars).",
      );
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production.");
    }
  } else {
    // Dev convenience: warn but don't block.
    const usingDefaults = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].some((s) =>
      s ? INSECURE_DEFAULTS.includes(s) : false,
    );
    if (usingDefaults) {
      // eslint-disable-next-line no-console
      console.warn("[env] Using default JWT secrets — fine for dev, NEVER for production.");
    }
  }
}
