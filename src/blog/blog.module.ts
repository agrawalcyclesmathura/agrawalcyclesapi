import { Module } from "@nestjs/common";
import {
  Controller, Get, Injectable, Param, Query,
} from "@nestjs/common";
import {
  ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, MaxLength, MinLength,
} from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

// ---- DTOs ---------------------------------------------------------------

class CreateBlogPostDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @ApiPropertyOptional({ description: "Auto-generated from title when omitted." })
  @IsOptional() @IsString() @MaxLength(220) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) excerpt?: string;
  @ApiProperty({ description: "Body — paragraphs separated by a blank line." })
  @IsString() @MinLength(1) content!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() coverUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) author?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() publishedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) metaTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) metaDesc?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
}

class UpdateBlogPostDto extends PartialType(CreateBlogPostDto) {
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

class BlogQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

// ---- Service ------------------------------------------------------------

const BLOG_OPTIONS: CrudServiceOptions = {
  model: "blogPost",
  entity: "BlogPost",
  searchFields: ["title", "excerpt", "category", "author"],
  sortable: ["publishedAt", "createdAt", "position", "title"],
  filterable: ["category", "isPublished", "isFeatured"],
  statusFields: ["isPublished", "isFeatured"],
  softDelete: true,
  orderField: "position",
  hasAudit: true,
  hasVersion: true,
  defaultSort: "-createdAt",
  slugFrom: "title",
  slugField: "slug",
};

@Injectable()
export class BlogService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit, BLOG_OPTIONS);
  }

  /** Published posts for the storefront (paginated, optional category/tag). */
  async storefront(params: { category?: string; tag?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(Math.max(1, Number(params.limit) || 12), 48);
    const skip = (page - 1) * limit;
    const where = {
      deletedAt: null,
      isPublished: true,
      ...(params.category ? { category: params.category } : {}),
      ...(params.tag ? { tags: { has: params.tag } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.blogPost.findMany({
        where,
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
        skip,
        take: limit,
      }),
      this.prisma.blogPost.count({ where }),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
  }

  /** A single published post by slug. */
  bySlug(slug: string) {
    return this.prisma.blogPost.findFirst({
      where: { slug, deletedAt: null, isPublished: true },
    });
  }

  /** Related published posts (same category first, then backfilled with recent), excluding the given slug. */
  async related(slug: string, limit = 3) {
    const post = await this.prisma.blogPost.findFirst({
      where: { slug, deletedAt: null },
      select: { category: true },
    });
    const order = [{ publishedAt: "desc" as const }, { createdAt: "desc" as const }];

    const sameCategory = post?.category
      ? await this.prisma.blogPost.findMany({
          where: { deletedAt: null, isPublished: true, slug: { not: slug }, category: post.category },
          orderBy: order,
          take: limit,
        })
      : [];

    if (sameCategory.length >= limit) return sameCategory;

    // Backfill with other recent posts so the section is never empty.
    const excludeSlugs = [slug, ...sameCategory.map((p) => p.slug)];
    const backfill = await this.prisma.blogPost.findMany({
      where: { deletedAt: null, isPublished: true, slug: { notIn: excludeSlugs } },
      orderBy: order,
      take: limit - sameCategory.length,
    });
    return [...sameCategory, ...backfill];
  }
}

// ---- Admin controller (inherits the full CRUD surface) ------------------

@ApiTags("blog")
@Controller({ path: "blog", version: "1" })
export class BlogController extends CrudController({
  permissions: {
    view: "blog:manage",
    create: "blog:manage",
    edit: "blog:manage",
    delete: "blog:manage",
  },
  createDto: CreateBlogPostDto,
  updateDto: UpdateBlogPostDto,
  queryDto: BlogQueryDto,
}) {
  constructor(private readonly blog: BlogService) {
    super(blog);
  }
}

// ---- Storefront controller (public) -------------------------------------

@ApiTags("storefront")
@Controller({ path: "storefront/blog", version: "1" })
export class StorefrontBlogController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get()
  list(
    @Query("category") category?: string,
    @Query("tag") tag?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.blog.storefront({
      category,
      tag,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Public()
  @Get(":slug")
  detail(@Param("slug") slug: string) {
    return this.blog.bySlug(slug);
  }

  @Public()
  @Get(":slug/related")
  related(@Param("slug") slug: string, @Query("limit") limit?: string) {
    return this.blog.related(slug, limit ? Number(limit) : 3);
  }
}

@Module({
  controllers: [BlogController, StorefrontBlogController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
