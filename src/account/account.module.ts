import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import * as argon2 from "argon2";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, type AuthUser } from "../auth/decorators";

// ---- DTOs ---------------------------------------------------------------

class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() avatarUrl?: string;
}

class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword!: string;
  @ApiProperty() @IsString() @MinLength(6) @MaxLength(100) newPassword!: string;
}

class CreateAddressDto {
  @ApiProperty() @IsString() @MaxLength(80) firstName!: string;
  @ApiProperty() @IsString() @MaxLength(80) lastName!: string;
  @ApiProperty() @IsString() @MaxLength(30) phone!: string;
  @ApiProperty() @IsString() line1!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() line2?: string;
  @ApiProperty() @IsString() city!: string;
  @ApiProperty() @IsString() state!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiProperty() @IsString() @MaxLength(16) zip!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateAddressDto extends PartialType(CreateAddressDto) {}

// ---- Service (all queries scoped to the authenticated user — IDOR-safe) ----

@Injectable()
class AccountService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private publicProfile(u: {
    id: string; email: string; firstName: string; lastName: string;
    phone: string | null; avatarUrl: string | null; emailVerified: boolean; createdAt: Date;
  }) {
    return {
      id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
      phone: u.phone, avatarUrl: u.avatarUrl, emailVerified: u.emailVerified, createdAt: u.createdAt,
    };
  }

  async profile(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.publicProfile(u);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto, ip?: string) {
    const u = await this.prisma.user.update({ where: { id: userId }, data: dto });
    await this.audit.record({
      actor: { sub: userId, email: u.email }, action: "account.profile.update",
      entity: "User", entityId: userId, after: dto, ip,
    });
    return this.publicProfile(u);
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = u.passwordHash && (await argon2.verify(u.passwordHash, dto.currentPassword));
    if (!ok) throw new BadRequestException("Current password is incorrect");
    await this.prisma.user.update({
      where: { id: userId }, data: { passwordHash: await argon2.hash(dto.newPassword) },
    });
    // Revoke all refresh tokens so other sessions are logged out.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actor: { sub: userId, email: u.email }, action: "account.password.change",
      entity: "User", entityId: userId, ip,
    });
    return { success: true };
  }

  async overview(userId: string) {
    const [orders, addresses] = await this.prisma.$transaction([
      this.prisma.order.count({ where: { userId } }),
      this.prisma.address.count({ where: { userId } }),
    ]);
    return { orders, addresses };
  }

  addresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
  }

  /** Ownership guard: an address must belong to the requesting user (IDOR protection). */
  private async ownAddressOrThrow(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({ where: { id, userId } });
    if (!address) throw new NotFoundException("Address not found");
    return address;
  }

  async createAddress(userId: string, dto: CreateAddressDto) {
    if (dto.isDefault) {
      await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    return this.prisma.address.create({ data: { ...dto, userId } });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto) {
    await this.ownAddressOrThrow(userId, id);
    if (dto.isDefault) {
      await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    return this.prisma.address.update({ where: { id }, data: dto });
  }

  async deleteAddress(userId: string, id: string) {
    await this.ownAddressOrThrow(userId, id);
    await this.prisma.address.delete({ where: { id } });
    return { success: true };
  }

  async setDefaultAddress(userId: string, id: string) {
    await this.ownAddressOrThrow(userId, id);
    await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return this.prisma.address.update({ where: { id }, data: { isDefault: true } });
  }

  private static readonly ORDER_ITEM_INCLUDE = {
    items: {
      include: {
        product: {
          select: {
            slug: true,
            images: { take: 1, orderBy: { position: "asc" as const }, select: { url: true } },
          },
        },
      },
    },
  };

  orders(userId: string) {
    return this.prisma.order.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        ...AccountService.ORDER_ITEM_INCLUDE,
        shipment: true,
        timeline: { where: { isInternal: false }, orderBy: { createdAt: "asc" } },
      },
    });
  }

  /** One order by id or orderNumber — ownership-scoped (IDOR-safe). Powers order-success + tracking. */
  async order(userId: string, ref: string) {
    const order = await this.prisma.order.findFirst({
      where: { userId, deletedAt: null, OR: [{ id: ref }, { orderNumber: ref }] },
      include: {
        ...AccountService.ORDER_ITEM_INCLUDE,
        shipment: true,
        invoice: true,
        shippingAddress: true,
        billingAddress: true,
        timeline: { where: { isInternal: false }, orderBy: { createdAt: "asc" } },
        payments: { select: { provider: true, status: true, amount: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}

// ---- Controller (JWT-auth; no @RequirePermissions → any signed-in user, own data only) ----

@ApiTags("account")
@ApiBearerAuth()
@Controller({ path: "account", version: "1" })
class AccountController {
  constructor(private readonly account: AccountService) {}

  private uuid = new ParseUUIDPipe({ version: "4" });

  @Get("profile")
  profile(@CurrentUser() user: AuthUser) {
    return this.account.profile(user.sub);
  }

  @Patch("profile")
  updateProfile(@Body() dto: UpdateProfileDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.account.updateProfile(user.sub, dto, req.ip);
  }

  @Post("password")
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.account.changePassword(user.sub, dto, req.ip);
  }

  @Get("overview")
  overview(@CurrentUser() user: AuthUser) {
    return this.account.overview(user.sub);
  }

  @Get("addresses")
  addresses(@CurrentUser() user: AuthUser) {
    return this.account.addresses(user.sub);
  }

  @Post("addresses")
  createAddress(@Body() dto: CreateAddressDto, @CurrentUser() user: AuthUser) {
    return this.account.createAddress(user.sub, dto);
  }

  @Patch("addresses/:id")
  updateAddress(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.account.updateAddress(user.sub, id, dto);
  }

  @Delete("addresses/:id")
  deleteAddress(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.account.deleteAddress(user.sub, id);
  }

  @Post("addresses/:id/default")
  setDefault(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.account.setDefaultAddress(user.sub, id);
  }

  @Get("orders")
  orders(@CurrentUser() user: AuthUser) {
    return this.account.orders(user.sub);
  }

  @Get("orders/:ref")
  order(@Param("ref") ref: string, @CurrentUser() user: AuthUser) {
    return this.account.order(user.sub, ref);
  }
}

@Module({
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
