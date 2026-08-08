import { Module } from "@nestjs/common";
import {
  Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, Public, RequirePermissions, type AuthUser } from "../auth/decorators";

const uuid = () => new ParseUUIDPipe({ version: "4" });

/** The homepage sections, in their default render order. Keys map to storefront components. */
const DEFAULT_SECTIONS: { key: string; title: string }[] = [
  { key: "hero", title: "Hero Slider" },
  { key: "services", title: "Services" },
  { key: "about", title: "About" },
  { key: "featured", title: "Featured Products" },
  { key: "parallax", title: "Parallax Banner" },
  { key: "promo", title: "Promo Cards" },
  { key: "shopParts", title: "Shop Parts" },
  { key: "testimonials", title: "Testimonials" },
  { key: "brands", title: "Brand Logos" },
  { key: "gallery", title: "Gallery" },
];

class UpdateSectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}
class ReorderDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) ids!: string[];
}

@Injectable()
export class HomeService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Create any missing default sections (idempotent), preserving the built-in order. */
  private async ensure() {
    const existing = new Set((await this.prisma.homeSection.findMany({ select: { key: true } })).map((s) => s.key));
    const missing = DEFAULT_SECTIONS.filter((s) => !existing.has(s.key));
    if (missing.length) {
      await this.prisma.homeSection.createMany({
        data: missing.map((s) => ({ key: s.key, title: s.title, position: DEFAULT_SECTIONS.findIndex((d) => d.key === s.key), isVisible: true })),
        skipDuplicates: true,
      });
    }
  }

  async list() {
    await this.ensure();
    return this.prisma.homeSection.findMany({ orderBy: { position: "asc" } });
  }

  async update(id: string, dto: UpdateSectionDto, actor?: AuthUser, ip?: string) {
    const section = await this.prisma.homeSection.findUnique({ where: { id } });
    if (!section) throw new NotFoundException("Section not found");
    const updated = await this.prisma.homeSection.update({ where: { id }, data: dto });
    await this.audit.record({ actor, action: "home.update", entity: "HomeSection", entityId: id, after: dto, ip });
    return updated;
  }

  async reorder(ids: string[], actor?: AuthUser, ip?: string) {
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.homeSection.update({ where: { id }, data: { position: i } })));
    await this.audit.record({ actor, action: "home.reorder", entity: "HomeSection", after: { ids }, ip });
    return { success: true };
  }

  /** Visible sections in order — for the storefront homepage. */
  async storefront() {
    await this.ensure();
    const sections = await this.prisma.homeSection.findMany({ where: { isVisible: true }, orderBy: { position: "asc" }, select: { key: true, title: true, subtitle: true } });
    return sections;
  }
}

@ApiTags("home")
@ApiBearerAuth()
@Controller({ path: "home-sections", version: "1" })
export class HomeController {
  constructor(private readonly home: HomeService) {}
  @RequirePermissions("home:manage") @Get() list() { return this.home.list(); }
  @RequirePermissions("home:manage") @Post("reorder") reorder(@Body() dto: ReorderDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.home.reorder(dto.ids, u, r.ip); }
  @RequirePermissions("home:manage") @Patch(":id") update(@Param("id", uuid()) id: string, @Body() dto: UpdateSectionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.home.update(id, dto, u, r.ip); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/home-sections", version: "1" })
export class StorefrontHomeController {
  constructor(private readonly home: HomeService) {}
  @Public() @Get() list() { return this.home.storefront(); }
}

@Module({
  controllers: [HomeController, StorefrontHomeController],
  providers: [HomeService],
  exports: [HomeService],
})
export class HomeModule {}
