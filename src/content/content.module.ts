import { Module } from "@nestjs/common";
import {
  Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType,
} from "@nestjs/swagger";
import {
  IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from "class-validator";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";
import { CurrentUser, Public, RequirePermissions, type AuthUser } from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

const uuid = () => new ParseUUIDPipe({ version: "4" });

// =========================================================================
// TESTIMONIALS — CRUD on the shared framework + public storefront list.
// =========================================================================

class CreateTestimonialDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) designation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) company?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 5 }) @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) quote!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}
class UpdateTestimonialDto extends PartialType(CreateTestimonialDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class TestimonialQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
}

const TESTIMONIAL_OPTIONS: CrudServiceOptions = {
  model: "testimonial", entity: "Testimonial",
  searchFields: ["name", "company", "quote"],
  sortable: ["position", "createdAt", "name"],
  filterable: ["isFeatured", "isVisible"],
  statusFields: ["isVisible", "isFeatured"],
  softDelete: true, hasAudit: true, hasVersion: true, orderField: "position", defaultSort: "position",
};

@Injectable()
export class TestimonialsService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) { super(prisma, audit, TESTIMONIAL_OPTIONS); }
  storefront(featured?: boolean) {
    return this.prisma.testimonial.findMany({
      where: { deletedAt: null, isVisible: true, ...(featured ? { isFeatured: true } : {}) },
      orderBy: { position: "asc" },
    });
  }
}

@ApiTags("testimonials")
@Controller({ path: "testimonials", version: "1" })
export class TestimonialsController extends CrudController({
  permissions: { view: "testimonials:manage", create: "testimonials:manage", edit: "testimonials:manage", delete: "testimonials:manage" },
  createDto: CreateTestimonialDto, updateDto: UpdateTestimonialDto, queryDto: TestimonialQueryDto,
}) {
  constructor(private readonly testimonials: TestimonialsService) { super(testimonials); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/testimonials", version: "1" })
export class StorefrontTestimonialsController {
  constructor(private readonly testimonials: TestimonialsService) {}
  @Public() @Get()
  list(@Query("featured") featured?: string) { return this.testimonials.storefront(featured === "true"); }
}

// =========================================================================
// FAQ — CRUD + public storefront list.
// =========================================================================

class CreateFaqDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(300) question!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(3000) answer!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() position?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}
class UpdateFaqDto extends PartialType(CreateFaqDto) {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}
class FaqQueryDto extends CrudQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isVisible?: boolean;
}

const FAQ_OPTIONS: CrudServiceOptions = {
  model: "faq", entity: "Faq",
  searchFields: ["question", "answer", "category"],
  sortable: ["position", "createdAt"],
  filterable: ["category", "isVisible"],
  statusFields: ["isVisible"],
  softDelete: true, hasAudit: true, hasVersion: true, orderField: "position", defaultSort: "position",
};

@Injectable()
export class FaqService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService) { super(prisma, audit, FAQ_OPTIONS); }
  storefront() {
    return this.prisma.faq.findMany({ where: { deletedAt: null, isVisible: true }, orderBy: [{ category: "asc" }, { position: "asc" }] });
  }
}

@ApiTags("faq")
@Controller({ path: "faqs", version: "1" })
export class FaqController extends CrudController({
  permissions: { view: "faq:manage", create: "faq:manage", edit: "faq:manage", delete: "faq:manage" },
  createDto: CreateFaqDto, updateDto: UpdateFaqDto, queryDto: FaqQueryDto,
}) {
  constructor(private readonly faqs: FaqService) { super(faqs); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/faqs", version: "1" })
export class StorefrontFaqController {
  constructor(private readonly faqs: FaqService) {}
  @Public() @Get()
  list() { return this.faqs.storefront(); }
}

// =========================================================================
// NEWSLETTER — public subscribe + admin inbox.
// =========================================================================

class SubscribeDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) source?: string;
}
class NewsletterQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isSubscribed?: boolean;
}

@Injectable()
export class NewsletterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async subscribe(email: string, source?: string) {
    const value = email.trim().toLowerCase();
    const existing = await this.prisma.newsletterSubscriber.findUnique({ where: { email: value } });
    if (existing) {
      if (!existing.isSubscribed) {
        await this.prisma.newsletterSubscriber.update({ where: { email: value }, data: { isSubscribed: true, unsubscribedAt: null } });
      }
      return { success: true, alreadySubscribed: existing.isSubscribed };
    }
    await this.prisma.newsletterSubscriber.create({ data: { email: value, source: source ?? "footer" } });
    await this.notifications.emitToStaff({
      type: "newsletter",
      title: "New newsletter subscriber",
      body: value,
      data: { href: "/admin/newsletter" },
    });
    return { success: true, alreadySubscribed: false };
  }

  async unsubscribe(email: string) {
    const value = email.trim().toLowerCase();
    await this.prisma.newsletterSubscriber.updateMany({ where: { email: value }, data: { isSubscribed: false, unsubscribedAt: new Date() } });
    return { success: true };
  }

  async list(q: NewsletterQueryDto) {
    const page = q.page ?? 1; const limit = Math.min(q.limit ?? 20, 100); const skip = (page - 1) * limit;
    const where: Record<string, unknown> = {};
    if (q.search) where.email = { contains: q.search, mode: "insensitive" };
    if (q.isSubscribed !== undefined) where.isSubscribed = q.isSubscribed;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.newsletterSubscriber.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
      this.prisma.newsletterSubscriber.count({ where }),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
  }

  async analytics() {
    const [total, subscribed] = await Promise.all([
      this.prisma.newsletterSubscriber.count(),
      this.prisma.newsletterSubscriber.count({ where: { isSubscribed: true } }),
    ]);
    return { total, subscribed, unsubscribed: total - subscribed };
  }

  async setSubscribed(id: string, isSubscribed: boolean, actor?: AuthUser, ip?: string) {
    const row = await this.prisma.newsletterSubscriber.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Subscriber not found");
    const updated = await this.prisma.newsletterSubscriber.update({ where: { id }, data: { isSubscribed, unsubscribedAt: isSubscribed ? null : new Date() } });
    await this.audit.record({ actor, action: "newsletter.update", entity: "NewsletterSubscriber", entityId: id, after: { isSubscribed }, ip });
    return updated;
  }

  async remove(id: string, actor?: AuthUser, ip?: string) {
    await this.prisma.newsletterSubscriber.delete({ where: { id } });
    await this.audit.record({ actor, action: "newsletter.delete", entity: "NewsletterSubscriber", entityId: id, ip });
    return { success: true, id };
  }
}

@ApiTags("newsletter")
@ApiBearerAuth()
@Controller({ path: "newsletter", version: "1" })
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}
  @RequirePermissions("newsletter:view") @Get()
  list(@Query() q: NewsletterQueryDto) { return this.newsletter.list(q); }
  @RequirePermissions("newsletter:view") @Get("reports/analytics")
  analytics() { return this.newsletter.analytics(); }
  @RequirePermissions("newsletter:manage") @Patch(":id")
  toggle(@Param("id", uuid()) id: string, @Body("isSubscribed") isSubscribed: boolean, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.newsletter.setSubscribed(id, isSubscribed, u, req.ip);
  }
  @RequirePermissions("newsletter:manage") @Delete(":id")
  remove(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.newsletter.remove(id, u, req.ip); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/newsletter", version: "1" })
export class StorefrontNewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}
  @Public() @Post()
  subscribe(@Body() dto: SubscribeDto) { return this.newsletter.subscribe(dto.email, dto.source); }
  @Public() @Post("unsubscribe")
  unsubscribe(@Body() dto: SubscribeDto) { return this.newsletter.unsubscribe(dto.email); }
}

// =========================================================================
// CONTACT — public submit + admin inbox.
// =========================================================================

class ContactSubmitDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(5000) message!: string;
}
class ContactQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional({ description: "unread | read | archived" }) @IsOptional() @IsString() status?: string;
}

@Injectable()
export class ContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async submit(dto: ContactSubmitDto, ip?: string) {
    await this.prisma.contactSubmission.create({ data: { ...dto, ip } });
    await this.notifications.emitToStaff({
      type: "contact",
      title: "New contact message",
      body: `${dto.name}${dto.subject ? ` — ${dto.subject}` : ""}`,
      data: { href: "/admin/contact" },
    });
    return { success: true, message: "Thank you — we'll get back to you shortly." };
  }

  async list(q: ContactQueryDto) {
    const page = q.page ?? 1; const limit = Math.min(q.limit ?? 20, 100); const skip = (page - 1) * limit;
    const where: Record<string, unknown> = {};
    if (q.status === "unread") where.isRead = false;
    else if (q.status === "read") { where.isRead = true; where.isArchived = false; }
    else if (q.status === "archived") where.isArchived = true;
    else where.isArchived = false;
    if (q.search) where.OR = [
      { name: { contains: q.search, mode: "insensitive" } },
      { email: { contains: q.search, mode: "insensitive" } },
      { subject: { contains: q.search, mode: "insensitive" } },
    ];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contactSubmission.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
      this.prisma.contactSubmission.count({ where }),
    ]);
    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
  }

  async analytics() {
    const [total, unread] = await Promise.all([
      this.prisma.contactSubmission.count({ where: { isArchived: false } }),
      this.prisma.contactSubmission.count({ where: { isRead: false, isArchived: false } }),
    ]);
    return { total, unread };
  }

  private async load(id: string) {
    const row = await this.prisma.contactSubmission.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Message not found");
    return row;
  }

  async setRead(id: string, isRead: boolean, actor?: AuthUser, ip?: string) {
    await this.load(id);
    const updated = await this.prisma.contactSubmission.update({ where: { id }, data: { isRead } });
    await this.audit.record({ actor, action: "contact.read", entity: "ContactSubmission", entityId: id, after: { isRead }, ip });
    return updated;
  }
  async setArchived(id: string, isArchived: boolean, actor?: AuthUser, ip?: string) {
    await this.load(id);
    const updated = await this.prisma.contactSubmission.update({ where: { id }, data: { isArchived, isRead: true } });
    await this.audit.record({ actor, action: "contact.archive", entity: "ContactSubmission", entityId: id, after: { isArchived }, ip });
    return updated;
  }
  async remove(id: string, actor?: AuthUser, ip?: string) {
    await this.load(id);
    await this.prisma.contactSubmission.delete({ where: { id } });
    await this.audit.record({ actor, action: "contact.delete", entity: "ContactSubmission", entityId: id, ip });
    return { success: true, id };
  }
}

@ApiTags("contact")
@ApiBearerAuth()
@Controller({ path: "contact", version: "1" })
export class ContactController {
  constructor(private readonly contact: ContactService) {}
  @RequirePermissions("contact:view") @Get()
  list(@Query() q: ContactQueryDto) { return this.contact.list(q); }
  @RequirePermissions("contact:view") @Get("reports/analytics")
  analytics() { return this.contact.analytics(); }
  @RequirePermissions("contact:manage") @Patch(":id/read")
  read(@Param("id", uuid()) id: string, @Body("isRead") isRead: boolean, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.contact.setRead(id, isRead ?? true, u, req.ip);
  }
  @RequirePermissions("contact:manage") @Patch(":id/archive")
  archive(@Param("id", uuid()) id: string, @Body("isArchived") isArchived: boolean, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.contact.setArchived(id, isArchived ?? true, u, req.ip);
  }
  @RequirePermissions("contact:manage") @Delete(":id")
  remove(@Param("id", uuid()) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.contact.remove(id, u, req.ip); }
}

@ApiTags("storefront")
@Controller({ path: "storefront/contact", version: "1" })
export class StorefrontContactController {
  constructor(private readonly contact: ContactService) {}
  @Public() @Post()
  submit(@Body() dto: ContactSubmitDto, @Req() req: Request) { return this.contact.submit(dto, req.ip); }
}

@Module({
  imports: [NotificationsModule],
  controllers: [
    TestimonialsController, StorefrontTestimonialsController,
    FaqController, StorefrontFaqController,
    NewsletterController, StorefrontNewsletterController,
    ContactController, StorefrontContactController,
  ],
  providers: [TestimonialsService, FaqService, NewsletterService, ContactService],
  exports: [TestimonialsService, FaqService, NewsletterService, ContactService],
})
export class ContentModule {}
