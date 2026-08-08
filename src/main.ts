import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe, VersioningType } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { validateEnv } from "./config/env.validation";

async function bootstrap() {
  // Fail fast on missing/weak configuration before anything boots.
  validateEnv();

  const isProd = process.env.NODE_ENV === "production";
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    // Quieter logs in production; verbose in development.
    logger: isProd ? ["error", "warn", "log"] : ["error", "warn", "log", "debug", "verbose"],
  });

  // Request id + structured access log. The id is echoed back so clients/proxies
  // can correlate a response with server logs.
  const httpLogger = new Logger("HTTP");
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers["x-request-id"] as string) || randomUUID();
    res.setHeader("x-request-id", id);
    const start = Date.now();
    res.on("finish", () => {
      const line = { id, method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start };
      httpLogger.log(isProd ? JSON.stringify(line) : `${line.method} ${line.url} ${line.status} ${line.ms}ms`);
    });
    next();
  });

  // Serve uploaded media (image library) as static assets.
  app.useStaticAssets(process.env.UPLOAD_DIR ?? join(process.cwd(), "uploads"), {
    prefix: "/uploads/",
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(","),
    credentials: true,
  });

  const prefix = process.env.API_PREFIX ?? "api";
  app.setGlobalPrefix(prefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const config = new DocumentBuilder()
    .setTitle("Agrawal Cycles API")
    .setDescription("Enterprise e-commerce backend — REST API v1")
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${prefix}/docs`, app, document);

  const port = Number(process.env.PORT ?? 4000);
  // Bind to 0.0.0.0 (all IPv4 interfaces) — required by Railway/containers, whose
  // proxy connects over IPv4. Without an explicit host, Node can bind IPv6-only
  // (`::`) and the platform can't reach the app → "Application failed to respond".
  await app.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`Agrawal Cycles API running on http://0.0.0.0:${port}/${prefix}/v1`);
}
bootstrap();
