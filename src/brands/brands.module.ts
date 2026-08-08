import { Module } from "@nestjs/common";
import {
  Controller, Get, Injectable, Param, Query,
} from "@nestjs/common";
import {
  ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// ---- DTOs ---------------------------------------------------------------

class CreateBrandDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bannerUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) metaTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(320) metaDesc?: string;
}

class UpdateBrandDto extends PartialType(CreateBrandDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

class BrandQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

// ---- Service ------------------------------------------------------------

const BRAND_OPTIONS: CrudServiceOptions = {
  model: "brand",
  entity: "Brand",
  searchFields: ["name", "slug", "description"],
  sortable: ["position", "name", "createdAt", "updatedAt"],
  filterable: ["isVisible", "isFeatured"],
  statusFields: ["isVisible", "isFeatured"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  slugFrom: "name",
  defaultSort: "position",
  include: { _count: { select: { products: true } } },
};

@Injectable()
export class BrandsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, BRAND_OPTIONS);
  }

  storefront(opts: { featured?: boolean } = {}) {
    return this.prisma.brand.findMany({
      where: { deletedAt: null, isVisible: true, ...(opts.featured ? { isFeatured: true } : {}) },
      orderBy: { position: "asc" },
      include: { _count: { select: { products: true } } },
    });
  }

  storefrontBySlug(slug: string) {
    return this.prisma.brand.findFirst({
      where: { slug, deletedAt: null, isVisible: true },
      include: { _count: { select: { products: true } } },
    });
  }
}

// ---- Admin controller ---------------------------------------------------

@ApiTags("brands")
@Controller({ path: "brands", version: "1" })
export class BrandsController extends CrudController({
  permissions: {
    view: "brands:view",
    create: "brands:manage",
    edit: "brands:manage",
    delete: "brands:manage",
  },
  createDto: CreateBrandDto,
  updateDto: UpdateBrandDto,
  queryDto: BrandQueryDto,
}) {
  constructor(private readonly brands: BrandsService) {
    super(brands);
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/brands", version: "1" })
export class StorefrontBrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Public() @Get()
  list(@Query("featured") featured?: string) {
    return this.brands.storefront({ featured: featured === "true" });
  }

  @Public() @Get(":slug")
  bySlug(@Param("slug") slug: string) {
    return this.brands.storefrontBySlug(slug);
  }
}

@Module({
  controllers: [BrandsController, StorefrontBrandsController],
  providers: [BrandsService],
})
export class BrandsModule {}
