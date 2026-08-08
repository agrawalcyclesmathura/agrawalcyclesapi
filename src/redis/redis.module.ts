import { Global, Logger, Module } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS = "REDIS_CLIENT";

/** Normalise REDIS_URL — tolerate a scheme-less value (a common env mistake,
 *  e.g. "default:pass@host:6379" or "//default:pass@host:6379"), which otherwise
 *  makes ioredis treat it as a unix socket path and fail with ENOENT. */
function redisUrl(): string {
  const raw = (process.env.REDIS_URL ?? "redis://localhost:6379").trim();
  if (/^rediss?:\/\//i.test(raw)) return raw;
  return `redis://${raw.replace(/^\/+/, "")}`;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const logger = new Logger("Redis");
        const client = new Redis(redisUrl(), {
          maxRetriesPerRequest: 3,
          // Bounded backoff so a misconfigured/unreachable Redis never spams or
          // destabilises the process (boot must not depend on Redis being up).
          retryStrategy: (times) => Math.min(times * 500, 5000),
        });
        // Attach an error handler so connection failures are logged, not emitted
        // as unhandled 'error' events (which can crash the process).
        client.on("error", (e) => logger.warn(`Redis connection error: ${e.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
