import { Module } from "@nestjs/common";
import { Body, ConflictException, Controller, Get, Injectable, Post } from "@nestjs/common";
import { ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import type { AuthUser } from "../auth/decorators";
import { Public } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions } from "../common/crud";

function normalizePath(p: string): string {
  let path = String(p).trim();
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

class CreateRedirectDto {
  @ApiProperty({ description: "Source path, e.g. /old-url" }) @IsString() @MinLength(1) @MaxLength(500) fromPath!: string;
  @ApiProperty({ description: "Destination path or URL" }) @IsString() @MinLength(1) @MaxLength(1000) toPath!: string;
  @ApiPropertyOptional({ enum: [301, 302] }) @IsOptional() @IsInt() @IsIn([301, 302]) statusCode?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateRedirectDto extends PartialType(CreateRedirectDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class RedirectQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class HitDto {
  @ApiProperty() @IsString() fromPath!: string;
}

const REDIRECT_OPTIONS: CrudServiceOptions = {
  model: "redirect", entity: "Redirect",
  searchFields: ["fromPath", "toPath"],
  sortable: ["createdAt", "hits", "fromPath"],
  filterable: ["isActive"],
  statusFields: ["isActive"],
  softDelete: true, hasAudit: true, hasVersion: true, defaultSort: "-createdAt",
};

@Injectable()
export class RedirectsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) { super(prisma, audit, REDIRECT_OPTIONS); }

  async create(dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    const fromPath = normalizePath(String(dto.fromPath));
    const clash = await this.prisma.redirect.findUnique({ where: { fromPath } });
    if (clash) throw new ConflictException("A redirect for this source path already exists");
    return super.create({ ...dto, fromPath, toPath: normalizePath(String(dto.toPath)) }, actor, ip);
  }

  async update(id: string, dto: Record<string, unknown>, actor?: AuthUser, ip?: string) {
    const data = { ...dto };
    if (dto.fromPath !== undefined) {
      const fromPath = normalizePath(String(dto.fromPath));
      const clash = await this.prisma.redirect.findFirst({ where: { fromPath, id: { not: id } } });
      if (clash) throw new ConflictException("A redirect for this source path already exists");
      data.fromPath = fromPath;
    }
    if (dto.toPath !== undefined) data.toPath = normalizePath(String(dto.toPath));
    return super.update(id, data, actor, ip);
  }

  /** Active redirects for the edge middleware (small map). */
  active() {
    return this.prisma.redirect.findMany({
      where: { deletedAt: null, isActive: true },
      select: { fromPath: true, toPath: true, statusCode: true },
    });
  }

  async hit(fromPath: string) {
    await this.prisma.redirect.updateMany({ where: { fromPath: normalizePath(fromPath) }, data: { hits: { increment: 1 } } });
    return { ok: true };
  }
}

@ApiTags("redirects")
@Controller({ path: "redirects", version: "1" })
export class RedirectsController extends CrudController({
  permissions: { view: "content:manage", create: "content:manage", edit: "content:manage", delete: "content:manage" },
  createDto: CreateRedirectDto, updateDto: UpdateRedirectDto, queryDto: RedirectQueryDto,
}) {
  constructor(private readonly redirects: RedirectsService) { super(redirects); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/redirects", version: "1" })
export class StorefrontRedirectsController {
  constructor(private readonly redirects: RedirectsService) {}
  @Public() @Get() list() { return this.redirects.active(); }
  @Public() @Post("hit") hit(@Body() dto: HitDto) { return this.redirects.hit(dto.fromPath); }
}

@Module({
  controllers: [RedirectsController, StorefrontRedirectsController],
  providers: [RedirectsService],
  exports: [RedirectsService],
})
export class RedirectsModule {}
