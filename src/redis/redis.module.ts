import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS = "REDIS_CLIENT";

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(process.env.REDIS_URL ?? "redis://localhost:6379"),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
