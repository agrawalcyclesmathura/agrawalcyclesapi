import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, Controller, Delete, Get, Headers, Injectable,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, Public, type AuthUser } from "../auth/decorators";

const MAX_QTY = 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- DTOs ---------------------------------------------------------------

class AddItemDto {
  @ApiProperty() @IsString() productId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() variantId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_QTY) quantity?: number;
}
class UpdateItemDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_QTY) quantity!: number;
}
class CouponDto {
  @ApiProperty() @IsString() code!: string;
}
class MergeDto {
  @ApiProperty() @IsString() guestId!: string;
}

type CartOwner = { userId: string } | { guestId: string };

// ---- Service ------------------------------------------------------------

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  private ownerWhere(owner: CartOwner) {
    return "userId" in owner ? { userId: owner.userId } : { guestId: owner.guestId };
  }

  private async getOrCreate(owner: CartOwner) {
    const where = this.ownerWhere(owner);
    const existing = await this.prisma.cart.findFirst({ where });
    if (existing) return existing;
    return this.prisma.cart.create({ data: where });
  }

  private async commerceSettings(): Promise<Record<string, number>> {
    const s = await this.prisma.setting.findUnique({ where: { key: "commerce" } });
    return (s?.value as Record<string, number>) ?? {};
  }

  private couponEffect(
    coupon: { type: string; value: unknown; minPurchase: unknown; maxDiscount: unknown; isActive: boolean; startsAt: Date | null; expiresAt: Date | null; usageLimit: number | null; usageCount: number },
    subtotal: number,
  ): { discount: number; freeShipping: boolean; valid: boolean; reason?: string } {
    const now = new Date();
    if (!coupon.isActive) return { discount: 0, freeShipping: false, valid: false, reason: "Coupon inactive" };
    if (coupon.startsAt && coupon.startsAt > now) return { discount: 0, freeShipping: false, valid: false, reason: "Coupon not started" };
    if (coupon.expiresAt && coupon.expiresAt < now) return { discount: 0, freeShipping: false, valid: false, reason: "Coupon expired" };
    if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) return { discount: 0, freeShipping: false, valid: false, reason: "Coupon usage limit reached" };
    if (coupon.minPurchase != null && subtotal < Number(coupon.minPurchase)) return { discount: 0, freeShipping: false, valid: false, reason: `Requires min. spend of ${Number(coupon.minPurchase)}` };

    let discount = 0;
    let freeShipping = false;
    switch (coupon.type) {
      case "PERCENT": discount = (subtotal * Number(coupon.value)) / 100; break;
      case "FIXED": discount = Number(coupon.value); break;
      case "FREE_SHIPPING": freeShipping = true; break;
      default: break;
    }
    if (coupon.maxDiscount != null) discount = Math.min(discount, Number(coupon.maxDiscount));
    discount = Math.min(discount, subtotal);
    return { discount, freeShipping, valid: true };
  }

  /** Load the cart and compute validated totals — the single source of price truth. */
  async view(owner: CartOwner) {
    const base = await this.getOrCreate(owner);
    const cart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: base.id },
      include: {
        coupon: true,
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: "asc" } }, inventory: true },
            },
          },
        },
      },
    });

    const settings = await this.commerceSettings();
    const issues: string[] = [];
    let subtotal = 0;
    let tax = 0;

    const items = cart.items.map((it) => {
      const p = it.product;
      const available = p.status === "PUBLISHED" && !p.deletedAt;
      const stock = p.inventory.reduce((n, i) => n + Math.max(0, i.quantity - i.reserved), 0);
      const unitPrice = Number(p.salePrice ?? p.price);
      const lineTotal = round2(unitPrice * it.quantity);
      if (!available) issues.push(`${p.name} is no longer available`);
      else if (it.quantity > stock) issues.push(`Only ${stock} left of ${p.name}`);
      if (available && it.quantity <= stock) {
        subtotal += lineTotal;
        tax += (lineTotal * Number(p.taxRate)) / 100;
      }
      return {
        itemId: it.id,
        productId: p.id,
        variantId: it.variantId,
        slug: p.slug,
        name: p.name,
        image: p.images[0]?.url ?? null,
        unitPrice,
        mrp: Number(p.mrp),
        quantity: it.quantity,
        lineTotal,
        stock,
        inStock: available && stock > 0,
        maxQuantity: Math.min(MAX_QTY, stock || MAX_QTY),
      };
    });

    subtotal = round2(subtotal);
    let discount = 0;
    let freeShipping = false;
    if (cart.coupon) {
      const eff = this.couponEffect(cart.coupon, subtotal);
      discount = eff.discount;
      freeShipping = eff.freeShipping;
      if (!eff.valid && eff.reason) issues.push(eff.reason);
    }
    discount = round2(discount);

    const flat = Number(settings.shippingFlat ?? 0);
    const threshold = Number(settings.freeShippingThreshold ?? 0);
    let shipping = subtotal > 0 ? flat : 0;
    if (freeShipping || (threshold > 0 && subtotal >= threshold)) shipping = 0;

    const taxTotal = round2(tax);
    const total = round2(subtotal - discount + taxTotal + shipping);

    return {
      id: cart.id,
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      couponCode: cart.coupon?.code ?? null,
      subtotal,
      discount,
      tax: taxTotal,
      shipping: round2(shipping),
      total,
      currency: (settings.currency as unknown as string) ?? "INR",
      issues,
    };
  }

  private async loadProductOrThrow(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, status: "PUBLISHED", deletedAt: null },
      include: { inventory: true },
    });
    if (!product) throw new NotFoundException("Product not available");
    return product;
  }

  async addItem(owner: CartOwner, dto: AddItemDto) {
    const cart = await this.getOrCreate(owner);
    const product = await this.loadProductOrThrow(dto.productId);
    const stock = product.inventory.reduce((n, i) => n + Math.max(0, i.quantity - i.reserved), 0);
    if (stock <= 0) throw new BadRequestException("Out of stock");

    const variantId = dto.variantId ?? null;
    const existing = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, productId: dto.productId, variantId },
    });
    const desired = (existing?.quantity ?? 0) + (dto.quantity ?? 1);
    const quantity = Math.min(desired, MAX_QTY, stock);

    if (existing) {
      await this.prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    } else {
      await this.prisma.cartItem.create({ data: { cartId: cart.id, productId: dto.productId, variantId, quantity } });
    }
    return this.view(owner);
  }

  private async ownedItem(owner: CartOwner, itemId: string) {
    const item = await this.prisma.cartItem.findUnique({ where: { id: itemId }, include: { cart: true } });
    const ok = item && ("userId" in owner ? item.cart.userId === owner.userId : item.cart.guestId === owner.guestId);
    if (!ok) throw new NotFoundException("Cart item not found"); // 404 (not 403) — no IDOR info leak
    return item!;
  }

  async updateItem(owner: CartOwner, itemId: string, quantity: number) {
    const item = await this.ownedItem(owner, itemId);
    const product = await this.loadProductOrThrow(item.productId);
    const stock = product.inventory.reduce((n, i) => n + Math.max(0, i.quantity - i.reserved), 0);
    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity: Math.min(quantity, MAX_QTY, Math.max(1, stock)) },
    });
    return this.view(owner);
  }

  async removeItem(owner: CartOwner, itemId: string) {
    await this.ownedItem(owner, itemId);
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.view(owner);
  }

  async clear(owner: CartOwner) {
    const cart = await this.getOrCreate(owner);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.view(owner);
  }

  async applyCoupon(owner: CartOwner, code: string) {
    const cart = await this.getOrCreate(owner);
    const coupon = await this.prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || coupon.deletedAt) throw new BadRequestException("Invalid coupon code");
    const current = await this.view(owner);
    const eff = this.couponEffect(coupon, current.subtotal);
    if (!eff.valid) throw new BadRequestException(eff.reason ?? "Coupon cannot be applied");

    // Per-customer usage cap (logged-in users only — counted from placed orders).
    if ("userId" in owner && coupon.perUserLimit != null) {
      const used = await this.prisma.order.count({ where: { userId: owner.userId, couponId: coupon.id, deletedAt: null } });
      if (used >= coupon.perUserLimit) {
        throw new BadRequestException("You have already used this coupon the maximum number of times");
      }
    }

    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponId: coupon.id } });
    return this.view(owner);
  }

  async removeCoupon(owner: CartOwner) {
    const cart = await this.getOrCreate(owner);
    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponId: null } });
    return this.view(owner);
  }

  /** Merge a guest cart into the logged-in user's cart, then delete the guest cart. */
  async merge(userId: string, guestId: string) {
    const guestCart = await this.prisma.cart.findFirst({ where: { guestId }, include: { items: true } });
    if (!guestCart) return this.view({ userId });
    if (guestCart.items.length) {
      const userCart = await this.getOrCreate({ userId });
      for (const it of guestCart.items) {
        const existing = await this.prisma.cartItem.findFirst({
          where: { cartId: userCart.id, productId: it.productId, variantId: it.variantId },
        });
        if (existing) {
          await this.prisma.cartItem.update({
            where: { id: existing.id },
            data: { quantity: Math.min(existing.quantity + it.quantity, MAX_QTY) },
          });
        } else {
          await this.prisma.cartItem.create({
            data: { cartId: userCart.id, productId: it.productId, variantId: it.variantId, quantity: Math.min(it.quantity, MAX_QTY) },
          });
        }
      }
    }
    await this.prisma.cart.delete({ where: { id: guestCart.id } });
    return this.view({ userId });
  }
}

// ---- Guest cart controller (public; identity via x-cart-token header) ----

function guestOwner(req: Request, header?: string): { guestId: string } {
  const id = header ?? (req.headers["x-cart-token"] as string | undefined);
  if (!id) throw new BadRequestException("Missing cart token");
  return { guestId: id };
}
const uuid = new ParseUUIDPipe({ version: "4" });

@ApiTags("storefront")
@Controller({ path: "storefront/cart", version: "1" })
export class StorefrontCartController {
  constructor(private readonly cart: CartService) {}

  @Public() @Get()
  view(@Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.view(guestOwner(req, token));
  }
  @Public() @Post("items")
  add(@Body() dto: AddItemDto, @Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.addItem(guestOwner(req, token), dto);
  }
  @Public() @Patch("items/:id")
  update(@Param("id", uuid) id: string, @Body() dto: UpdateItemDto, @Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.updateItem(guestOwner(req, token), id, dto.quantity);
  }
  @Public() @Delete("items/:id")
  remove(@Param("id", uuid) id: string, @Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.removeItem(guestOwner(req, token), id);
  }
  @Public() @Delete()
  clear(@Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.clear(guestOwner(req, token));
  }
  @Public() @Post("coupon")
  coupon(@Body() dto: CouponDto, @Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.applyCoupon(guestOwner(req, token), dto.code);
  }
  @Public() @Delete("coupon")
  removeCoupon(@Req() req: Request, @Headers("x-cart-token") token?: string) {
    return this.cart.removeCoupon(guestOwner(req, token));
  }
}

// ---- Account cart controller (authed; identity via JWT userId) ----

@ApiTags("account")
@ApiBearerAuth()
@Controller({ path: "account/cart", version: "1" })
export class AccountCartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  view(@CurrentUser() u: AuthUser) {
    return this.cart.view({ userId: u.sub });
  }
  @Post("items")
  add(@CurrentUser() u: AuthUser, @Body() dto: AddItemDto) {
    return this.cart.addItem({ userId: u.sub }, dto);
  }
  @Patch("items/:id")
  update(@CurrentUser() u: AuthUser, @Param("id", uuid) id: string, @Body() dto: UpdateItemDto) {
    return this.cart.updateItem({ userId: u.sub }, id, dto.quantity);
  }
  @Delete("items/:id")
  remove(@CurrentUser() u: AuthUser, @Param("id", uuid) id: string) {
    return this.cart.removeItem({ userId: u.sub }, id);
  }
  @Delete()
  clear(@CurrentUser() u: AuthUser) {
    return this.cart.clear({ userId: u.sub });
  }
  @Post("coupon")
  coupon(@CurrentUser() u: AuthUser, @Body() dto: CouponDto) {
    return this.cart.applyCoupon({ userId: u.sub }, dto.code);
  }
  @Delete("coupon")
  removeCoupon(@CurrentUser() u: AuthUser) {
    return this.cart.removeCoupon({ userId: u.sub });
  }
  @Post("merge")
  merge(@CurrentUser() u: AuthUser, @Body() dto: MergeDto) {
    return this.cart.merge(u.sub, dto.guestId);
  }
}

@Module({
  controllers: [StorefrontCartController, AccountCartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
