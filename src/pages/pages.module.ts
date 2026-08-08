import { Module } from "@nestjs/common";
import { Controller, Get, Injectable, NotFoundException, Param } from "@nestjs/common";
import { ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { Public } from "../auth/decorators";
import { BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions } from "../common/crud";

class CreatePageDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) slug?: string;
  @ApiProperty() @IsString() content!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) excerpt?: string;
  @ApiPropertyOptional({ description: "default | legal | marketing" }) @IsOptional() @IsString() template?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) metaTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) metaDesc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() ogImageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
}
class UpdatePageDto extends PartialType(CreatePageDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class PageQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() template?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
}

const PAGE_OPTIONS: CrudServiceOptions = {
  model: "page", entity: "Page",
  searchFields: ["title", "slug", "content"],
  sortable: ["position", "createdAt", "title"],
  filterable: ["template", "isPublished"],
  statusFields: ["isPublished"],
  softDelete: true, hasAudit: true, hasVersion: true,
  slugFrom: "title", slugField: "slug", orderField: "position", defaultSort: "position",
};

@Injectable()
export class PagesService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) { super(prisma, audit, PAGE_OPTIONS); }

  async bySlug(slug: string) {
    const page = await this.prisma.page.findFirst({ where: { slug, isPublished: true, deletedAt: null } });
    if (!page) throw new NotFoundException("Page not found");
    return page;
  }
  publishedList() {
    return this.prisma.page.findMany({
      where: { isPublished: true, deletedAt: null },
      orderBy: { position: "asc" },
      select: { title: true, slug: true, excerpt: true, template: true },
    });
  }
}

@ApiTags("pages")
@Controller({ path: "pages", version: "1" })
export class PagesController extends CrudController({
  permissions: { view: "pages:manage", create: "pages:manage", edit: "pages:manage", delete: "pages:manage" },
  createDto: CreatePageDto, updateDto: UpdatePageDto, queryDto: PageQueryDto,
}) {
  constructor(private readonly pages: PagesService) { super(pages); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/pages", version: "1" })
export class StorefrontPagesController {
  constructor(private readonly pages: PagesService) {}
  @Public() @Get() list() { return this.pages.publishedList(); }
  @Public() @Get(":slug") bySlug(@Param("slug") slug: string) { return this.pages.bySlug(slug); }
}

@Module({
  controllers: [PagesController, StorefrontPagesController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
