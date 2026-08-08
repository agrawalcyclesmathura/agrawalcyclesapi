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

class CreateCategoryDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() iconUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bannerUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) metaTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(320) metaDesc?: string;
}

class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

class CategoryQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

// ---- Service ------------------------------------------------------------

const CATEGORY_OPTIONS: CrudServiceOptions = {
  model: "category",
  entity: "Category",
  searchFields: ["name", "slug", "description"],
  sortable: ["position", "name", "createdAt", "updatedAt"],
  filterable: ["parentId", "isVisible", "isFeatured"],
  statusFields: ["isVisible", "isFeatured"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  slugFrom: "name",
  defaultSort: "position",
  include: {
    parent: { select: { id: true, name: true } },
    _count: { select: { products: true, children: true } },
  },
};

@Injectable()
export class CategoriesService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, CATEGORY_OPTIONS);
  }

  /** Storefront: visible categories with live product counts. */
  storefront(opts: { featured?: boolean } = {}) {
    return this.prisma.category.findMany({
      where: {
        deletedAt: null,
        isVisible: true,
        ...(opts.featured ? { isFeatured: true } : {}),
      },
      orderBy: { position: "asc" },
      include: { _count: { select: { products: true } } },
    });
  }

  /** Storefront: nested visible tree (2 levels). */
  storefrontTree() {
    return this.prisma.category.findMany({
      where: { deletedAt: null, isVisible: true, parentId: null },
      orderBy: { position: "asc" },
      include: {
        children: {
          where: { deletedAt: null, isVisible: true },
          orderBy: { position: "asc" },
        },
        _count: { select: { products: true } },
      },
    });
  }

  async storefrontBySlug(slug: string) {
    return this.prisma.category.findFirst({
      where: { slug, deletedAt: null, isVisible: true },
      include: {
        children: { where: { deletedAt: null, isVisible: true }, orderBy: { position: "asc" } },
        _count: { select: { products: true } },
      },
    });
  }
}

// ---- Admin controller (full CRUD via the shared framework) --------------

@ApiTags("categories")
@Controller({ path: "categories", version: "1" })
export class CategoriesController extends CrudController({
  permissions: {
    view: "categories:view",
    create: "categories:manage",
    edit: "categories:manage",
    delete: "categories:manage",
  },
  createDto: CreateCategoryDto,
  updateDto: UpdateCategoryDto,
  queryDto: CategoryQueryDto,
}) {
  constructor(private readonly categories: CategoriesService) {
    super(categories);
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/categories", version: "1" })
export class StorefrontCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public() @Get()
  list(@Query("featured") featured?: string) {
    return this.categories.storefront({ featured: featured === "true" });
  }

  @Public() @Get("tree")
  tree() {
    return this.categories.storefrontTree();
  }

  @Public() @Get(":slug")
  bySlug(@Param("slug") slug: string) {
    return this.categories.storefrontBySlug(slug);
  }
}

@Module({
  controllers: [CategoriesController, StorefrontCategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
