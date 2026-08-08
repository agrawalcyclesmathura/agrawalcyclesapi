import { Module } from "@nestjs/common";
import {
  Body, Controller, Get, Injectable, Param, Put, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, Public, RequirePermissions, type AuthUser } from "../auth/decorators";

/**
 * Settings are stored one row per group: `key` = group name, `value` = JSON object.
 * `group` marks exposure: "public" groups are served to the storefront; "private"
 * groups (SMTP, secret keys) are admin-only.
 */
const PUBLIC_GROUPS = [
  "general", "contact", "social", "commerce", "seo", "analytics", "features",
];
const PRIVATE_GROUPS = ["smtp", "integrations"];

class UpsertSettingDto {
  @ApiProperty({ type: Object, description: "Arbitrary JSON payload for this group" })
  @IsObject()
  value!: Record<string, unknown>;

  @ApiProperty({ required: false, description: "public | private" })
  @IsOptional() @IsString() group?: string;
}

@Injectable()
class SettingsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private groupOf(key: string): string {
    return PRIVATE_GROUPS.includes(key) ? "private" : "public";
  }

  /** All settings as a `{ key: value }` map (admin). */
  async all(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Only storefront-safe groups. Secrets (smtp/integrations) are never returned. */
  async publicSettings(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany({ where: { group: "public" } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Guarantee the expected shape even before anything is seeded.
    for (const g of PUBLIC_GROUPS) if (!(g in map)) map[g] = {};
    return map;
  }

  async getOne(key: string) {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return { key, value: row?.value ?? {}, group: row?.group ?? this.groupOf(key) };
  }

  async upsert(key: string, dto: UpsertSettingDto, actor: AuthUser, ip?: string) {
    const existing = await this.prisma.setting.findUnique({ where: { key } });
    const group = dto.group ?? this.groupOf(key);
    const row = await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: dto.value as object, group },
      update: { value: dto.value as object, group },
    });
    await this.audit.record({
      actor, action: existing ? "settings.update" : "settings.create",
      entity: "Setting", entityId: key, before: existing?.value, after: dto.value, ip,
    });
    return row;
  }
}

@ApiTags("settings")
@Controller({ path: "settings", version: "1" })
class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get("public")
  publicSettings() {
    return this.settings.publicSettings();
  }

  @ApiBearerAuth()
  @RequirePermissions("settings:manage")
  @Get()
  all() {
    return this.settings.all();
  }

  @ApiBearerAuth()
  @RequirePermissions("settings:manage")
  @Get(":key")
  getOne(@Param("key") key: string) {
    return this.settings.getOne(key);
  }

  @ApiBearerAuth()
  @RequirePermissions("settings:manage")
  @Put(":key")
  upsert(
    @Param("key") key: string,
    @Body() dto: UpsertSettingDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.settings.upsert(key, dto, user, req.ip);
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
