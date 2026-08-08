import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";

/** Global module exposing cross-cutting services (audit trail, etc.). */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class CommonModule {}
