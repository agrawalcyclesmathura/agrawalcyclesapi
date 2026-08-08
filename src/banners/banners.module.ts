import { Module } from "@nestjs/common";
import {
  Controller, Get, Injectable, Query,
} from "@nestjs/common";
import {
  ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// ---- DTOs ---------------------------------------------------------------

class CreateBannerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) eyebrow?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) badge?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty() @IsString() imageUrl!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() mobileUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() videoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) buttonText?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() secondaryText?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() secondaryUrl?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100) overlayOpacity?: number;
  @ApiPropertyOptional({ enum: ["left", "center", "right"] })
  @IsOptional() @IsIn(["left", "center", "right"]) alignment?: string;
  @ApiPropertyOptional({ enum: ["light", "dark"] })
  @IsOptional() @IsIn(["light", "dark"]) theme?: string;
  @ApiPropertyOptional({ type: Object, description: "{ enabled, type, duration, delay }" })
  @IsOptional() @IsObject() animation?: Record<string, unknown>;
  @ApiPropertyOptional({ description: "hero | promo | announcement | popup | category" })
  @IsOptional() @IsString() placement?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
}

class UpdateBannerDto extends PartialType(CreateBannerDto) {
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

class BannerQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() placement?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// ---- Service ------------------------------------------------------------

const BANNER_OPTIONS: CrudServiceOptions = {
  model: "banner",
  entity: "Banner",
  searchFields: ["title", "subtitle", "eyebrow", "placement"],
  sortable: ["position", "createdAt", "updatedAt", "title", "placement"],
  filterable: ["placement", "isActive"],
  statusFields: ["isActive"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  defaultSort: "position",
};

@Injectable()
export class BannersService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, BANNER_OPTIONS);
  }

  /** Active, in-window banners for the storefront (no auth). */
  storefront(placement?: string) {
    const now = new Date();
    return this.prisma.banner.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ...(placement ? { placement } : {}),
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { position: "asc" },
    });
  }
}

// ---- Admin controller (inherits the full CRUD surface) ------------------

@ApiTags("banners")
@Controller({ path: "banners", version: "1" })
export class BannersController extends CrudController({
  permissions: {
    view: "banners:view",
    create: "banners:manage",
    edit: "banners:manage",
    delete: "banners:manage",
  },
  createDto: CreateBannerDto,
  updateDto: UpdateBannerDto,
  queryDto: BannerQueryDto,
}) {
  constructor(private readonly banners: BannersService) {
    super(banners);
  }
}

// ---- Storefront controller (public, separate path — no route collisions) -

@ApiTags("storefront")
@Controller({ path: "storefront/banners", version: "1" })
export class StorefrontBannersController {
  constructor(private readonly banners: BannersService) {}

  @Public()
  @Get()
  list(@Query("placement") placement?: string) {
    return this.banners.storefront(placement);
  }
}

@Module({
  controllers: [BannersController, StorefrontBannersController],
  providers: [BannersService],
})
export class BannersModule {}
