import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from "@nestjs/common";
import {
  ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags,
} from "@nestjs/swagger";
import {
  IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { OrderStatus, PaymentStatus, Prisma, type PrismaClient } from "@prisma/client";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { CartService, CartModule } from "../cart/cart.module";
import { PaymentsModule, PaymentService, RazorpayService, type CheckoutParams } from "../payments/payments.module";
import { AuditService } from "../common/audit.service";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";
import {
  CurrentUser, RequirePermissions, Roles, type AuthUser,
} from "../auth/decorators";
import {
  BaseCrudService, CrudController, CrudQueryDto, type CrudServiceOptions,
} from "../common/crud";

const round2 = (n: number) => Math.round(n * 100) / 100;
const EXPRESS_RATE = 150;

type Tx = Prisma.TransactionClient;

// ---- DTOs ---------------------------------------------------------------

class AddressInputDto {
  @ApiProperty() @IsString() @MinLength(1) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) lastName!: string;
  @ApiProperty() @IsString() @MinLength(3) phone!: string;
  @ApiProperty() @IsString() @MinLength(3) line1!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() line2?: string;
  @ApiProperty() @IsString() @MinLength(1) city!: string;
  @ApiProperty() @IsString() @MinLength(1) state!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
  @ApiProperty() @IsString() @MinLength(3) zip!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() saveAddress?: boolean;
}

class PlaceOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() shippingAddressId?: string;
  @ApiPropertyOptional({ type: AddressInputDto })
  @IsOptional() @ValidateNested() @Type(() => AddressInputDto) shippingAddress?: AddressInputDto;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() billingSameAsShipping?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() billingAddressId?: string;
  @ApiPropertyOptional({ type: AddressInputDto })
  @IsOptional() @ValidateNested() @Type(() => AddressInputDto) billingAddress?: AddressInputDto;
  @ApiProperty({ enum: ["standard", "express"] })
  @IsIn(["standard", "express"]) shippingMethod!: string;
  @ApiProperty({ description: "cod | card | upi | netbanking | wallet" })
  @IsString() paymentMethod!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

// ---- Service ------------------------------------------------------------

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private cart: CartService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  private async commerceSettings(db: Tx | PrismaClient | PrismaService): Promise<Record<string, unknown>> {
    const s = await (db as PrismaService).setting.findUnique({ where: { key: "commerce" } });
    return (s?.value as Record<string, unknown>) ?? {};
  }

  private shippingMethods(subtotal: number, settings: Record<string, unknown>, freeShipping: boolean) {
    const flat = Number(settings.shippingFlat ?? 0);
    const threshold = Number(settings.freeShippingThreshold ?? 0);
    const standard = freeShipping || (threshold > 0 && subtotal >= threshold) ? 0 : flat;
    return [
      { code: "standard", label: "Standard Delivery (2–3 business days)", rate: round2(standard) },
      { code: "express", label: "Express Delivery (next business day)", rate: EXPRESS_RATE },
    ];
  }

  private couponEffect(
    c: { type: string; value: unknown; minPurchase: unknown; maxDiscount: unknown; isActive: boolean; startsAt: Date | null; expiresAt: Date | null; usageLimit: number | null; usageCount: number },
    subtotal: number,
  ) {
    const now = new Date();
    if (!c.isActive || (c.startsAt && c.startsAt > now) || (c.expiresAt && c.expiresAt < now)) return { discount: 0, freeShipping: false, valid: false };
    if (c.usageLimit != null && c.usageCount >= c.usageLimit) return { discount: 0, freeShipping: false, valid: false };
    if (c.minPurchase != null && subtotal < Number(c.minPurchase)) return { discount: 0, freeShipping: false, valid: false };
    let discount = 0, freeShipping = false;
    if (c.type === "PERCENT") discount = (subtotal * Number(c.value)) / 100;
    else if (c.type === "FIXED") discount = Number(c.value);
    else if (c.type === "FREE_SHIPPING") freeShipping = true;
    if (c.maxDiscount != null) discount = Math.min(discount, Number(c.maxDiscount));
    return { discount: Math.min(discount, subtotal), freeShipping, valid: true };
  }

  /** Everything the checkout screen needs: validated cart + saved addresses + shipping options. */
  async context(userId: string) {
    const [cart, addresses, cartRow] = await Promise.all([
      this.cart.view({ userId }),
      this.prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }),
      this.prisma.cart.findFirst({ where: { userId }, include: { coupon: true } }),
    ]);
    const settings = await this.commerceSettings(this.prisma);
    const freeShip = cartRow?.coupon?.type === "FREE_SHIPPING";
    return { cart, addresses, shippingMethods: this.shippingMethods(cart.subtotal, settings, freeShip) };
  }

  private async resolveAddress(tx: Tx, userId: string, addressId?: string, data?: AddressInputDto) {
    if (addressId) {
      const a = await tx.address.findFirst({ where: { id: addressId, userId } });
      if (!a) throw new NotFoundException("Address not found");
      return a;
    }
    if (data) {
      const { saveAddress, ...addr } = data;
      return tx.address.create({ data: { ...addr, userId } });
    }
    throw new BadRequestException("Shipping address is required");
  }

  private orderNumber() {
    return `AC-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`;
  }

  /**
   * Place an order from the user's cart — atomically (one transaction):
   * validate stock → deduct inventory (overselling-safe) → snapshot prices →
   * create order + items + timeline + payment → apply coupon → clear cart.
   */
  async placeOrder(userId: string, email: string, dto: PlaceOrderDto, ip?: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({
        where: { userId },
        include: { coupon: true, items: { include: { product: { include: { inventory: true } } } } },
      });
      if (!cart || cart.items.length === 0) throw new BadRequestException("Your cart is empty");

      const settings = await this.commerceSettings(tx);
      const shipAddr = await this.resolveAddress(tx, userId, dto.shippingAddressId, dto.shippingAddress);
      const sameBilling = dto.billingSameAsShipping !== false && !dto.billingAddressId && !dto.billingAddress;
      const billAddr = sameBilling ? shipAddr : await this.resolveAddress(tx, userId, dto.billingAddressId, dto.billingAddress);

      const orderNumber = this.orderNumber();
      let subtotal = 0;
      let taxTotal = 0;
      const orderItems: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] = [];

      for (const it of cart.items) {
        const p = it.product;
        if (p.status !== "PUBLISHED" || p.deletedAt) throw new BadRequestException(`${p.name} is no longer available`);
        const inv = p.inventory[0];
        if (!inv) throw new BadRequestException(`${p.name} is out of stock`);

        // Atomic guarded decrement — prevents overselling under concurrency.
        const dec = await tx.inventoryItem.updateMany({
          where: { id: inv.id, quantity: { gte: it.quantity } },
          data: { quantity: { decrement: it.quantity } },
        });
        if (dec.count === 0) throw new BadRequestException(`Insufficient stock for ${p.name}`);
        await tx.stockMovement.create({
          data: { inventoryItemId: inv.id, type: "SALE", quantity: -it.quantity, note: `Order ${orderNumber}` },
        });

        const unitPrice = Number(p.salePrice ?? p.price);
        const lineTotal = round2(unitPrice * it.quantity);
        subtotal += lineTotal;
        taxTotal += (lineTotal * Number(p.taxRate)) / 100;
        orderItems.push({ productId: p.id, name: p.name, sku: p.sku, price: unitPrice, quantity: it.quantity, total: lineTotal });
      }
      subtotal = round2(subtotal);
      taxTotal = round2(taxTotal);

      let discount = 0;
      let freeShipping = false;
      if (cart.coupon) {
        const eff = this.couponEffect(cart.coupon, subtotal);
        if (eff.valid) {
          discount = round2(eff.discount);
          freeShipping = eff.freeShipping;
          await tx.coupon.update({ where: { id: cart.coupon.id }, data: { usageCount: { increment: 1 } } });
        }
      }

      const method = this.shippingMethods(subtotal, settings, freeShipping).find((m) => m.code === dto.shippingMethod)!;
      const shipping = round2(method.rate);
      const grandTotal = round2(subtotal - discount + taxTotal + shipping);
      const currency = (settings.currency as string) ?? "INR";
      const isCOD = dto.paymentMethod.toLowerCase() === "cod";

      const created = await tx.order.create({
        data: {
          orderNumber, userId, email,
          status: isCOD ? "CONFIRMED" : "PENDING",
          paymentStatus: "PENDING",
          subtotal, discountTotal: discount, taxTotal, shippingTotal: shipping, grandTotal, currency,
          couponId: cart.coupon?.id ?? null,
          shippingAddressId: shipAddr.id, billingAddressId: billAddr.id,
          notes: dto.notes,
          items: { create: orderItems },
          timeline: { create: [{ status: isCOD ? "CONFIRMED" : "PENDING", message: isCOD ? "Order confirmed — Cash on Delivery" : "Order placed — awaiting payment" }] },
          payments: { create: [{ provider: isCOD ? "COD" : "RAZORPAY", status: "PENDING", amount: grandTotal, currency }] },
        },
        include: { items: true },
      });

      // Clear the cart.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { couponId: null } });

      return created;
    });

    await this.audit.record({
      actor: { sub: userId, email }, action: "order.placed", entity: "Order",
      entityId: order.id, after: { orderNumber: order.orderNumber, grandTotal: order.grandTotal }, ip,
    });

    // Event-driven admin notification (best-effort; never blocks the order).
    await this.notifications.emitToStaff({
      type: "order",
      title: `New order ${order.orderNumber}`,
      body: `${email} · ${order.currency} ${order.grandTotal}`,
      data: { orderId: order.id, orderNumber: order.orderNumber, href: `/admin/orders/${order.id}` },
    });
    return order;
  }
}

// ---- Controller (authed customer checkout) ------------------------------

@ApiTags("account")
@ApiBearerAuth()
@Controller({ path: "account/checkout", version: "1" })
class CheckoutController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentService,
  ) {}

  @Get()
  context(@CurrentUser() u: AuthUser) {
    return this.orders.context(u.sub);
  }

  @Post()
  async place(@CurrentUser() u: AuthUser, @Body() dto: PlaceOrderDto) {
    const order = await this.orders.placeOrder(u.sub, u.email, dto);
    // For online payments, spin up a gateway order so the client can open checkout
    // immediately. COD / unconfigured → `payment` stays null and the flow completes.
    let payment: CheckoutParams | null = null;
    if (order.paymentStatus !== "PAID" && dto.paymentMethod.toLowerCase() !== "cod") {
      try {
        payment = await this.payments.createForOrder(u.sub, order.id);
      } catch {
        payment = { configured: false, orderId: order.id, orderNumber: order.orderNumber };
      }
    }
    return { ...order, payment };
  }
}

// =========================================================================
// ADMIN ORDER MANAGEMENT
// Order list · detail · status workflow · payment · notes · shipment ·
// invoice · refunds · analytics — built on the shared CRUD framework.
// =========================================================================

/** Allowed status transitions — enforced server-side (the order lifecycle). */
const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED", "REFUNDED"],
  CANCELLED: ["REFUNDED"],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
};

/** Statuses whose inventory was deducted and must be returned to stock on cancel/return. */
const RESTOCK_ON: OrderStatus[] = ["CANCELLED", "RETURNED"];

const STATUS_MESSAGE: Record<OrderStatus, string> = {
  PENDING: "Order placed — awaiting confirmation",
  CONFIRMED: "Order confirmed",
  PROCESSING: "Order is being processed",
  PACKED: "Order packed and ready to ship",
  SHIPPED: "Order shipped",
  DELIVERED: "Order delivered",
  CANCELLED: "Order cancelled",
  RETURNED: "Order returned",
  REFUNDED: "Order refunded",
};

// ---- Admin DTOs ---------------------------------------------------------

class CreateOrderAdminDto {} // orders originate from checkout — create is disabled

class UpdateOrderAdminDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) adminNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ description: "Optimistic-lock version" })
  @IsOptional() @IsInt() version?: number;
}

class OrderQueryDto extends CrudQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) paymentStatus?: PaymentStatus;
}

class UpdateStatusDto {
  @ApiProperty({ enum: OrderStatus }) @IsEnum(OrderStatus) status!: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PaymentStatus }) @IsEnum(PaymentStatus) paymentStatus!: PaymentStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
}

class AddNoteDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) message!: string;
  @ApiPropertyOptional({ description: "Internal notes are hidden from the customer." })
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class UpdateShipmentDto {
  @ApiPropertyOptional({ description: "Courier / carrier name" })
  @IsOptional() @IsString() @MaxLength(100) provider?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) trackingNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) trackingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() shippedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() deliveredAt?: string;
}

class RefundDto {
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class AnalyticsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional() @IsInt() @Min(1) @Max(365) days?: number;
}

// ---- Admin service ------------------------------------------------------

const ORDER_LIST_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  _count: { select: { items: true } },
};

const ORDER_DETAIL_INCLUDE = {
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
  timeline: { orderBy: { createdAt: "asc" as const } },
  payments: { include: { refunds: true }, orderBy: { createdAt: "asc" as const } },
  shipment: true,
  invoice: true,
  coupon: { select: { code: true, type: true, value: true } },
  shippingAddress: true,
  billingAddress: true,
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
};

const ORDER_OPTIONS: CrudServiceOptions = {
  model: "order",
  entity: "Order",
  searchFields: ["orderNumber", "email"],
  sortable: ["createdAt", "updatedAt", "grandTotal", "orderNumber", "status"],
  filterable: ["status", "paymentStatus"],
  softDelete: true,
  hasAudit: true,
  hasVersion: true,
  defaultSort: "-createdAt",
  include: ORDER_LIST_INCLUDE,
};

@Injectable()
export class OrdersAdminService extends BaseCrudService {
  constructor(prisma: PrismaService, audit: AuditService, private readonly razorpay: RazorpayService) {
    super(prisma, audit, ORDER_OPTIONS);
  }

  /** Orders are created by the checkout flow, never hand-authored in the admin. */
  async create(): Promise<never> {
    throw new BadRequestException("Orders are created through checkout, not the admin panel.");
  }

  /** Full order for the detail screen (items, timeline, payments, addresses, shipment, invoice). */
  async detail(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  private assertVersion(current: number, expected?: number) {
    if (expected !== undefined && current !== expected) {
      throw new ConflictException("Order was modified by someone else. Reload and try again.");
    }
  }

  /** Move an order through its lifecycle, recording a timeline event and handling side-effects. */
  async updateStatus(id: string, dto: UpdateStatusDto, actor?: AuthUser, ip?: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      if (!order) throw new NotFoundException("Order not found");
      this.assertVersion(order.version, dto.version);

      const from = order.status;
      const to = dto.status;
      if (from === to) throw new BadRequestException(`Order is already ${to}`);
      if (!(STATUS_FLOW[from] ?? []).includes(to)) {
        throw new BadRequestException(`Cannot change status from ${from} to ${to}`);
      }

      // Return goods to stock when an order is cancelled or returned.
      if (RESTOCK_ON.includes(to)) {
        for (const it of order.items) {
          if (!it.productId) continue;
          const inv = await tx.inventoryItem.findFirst({ where: { productId: it.productId } });
          if (!inv) continue;
          await tx.inventoryItem.update({
            where: { id: inv.id },
            data: { quantity: { increment: it.quantity } },
          });
          await tx.stockMovement.create({
            data: {
              inventoryItemId: inv.id, type: "RETURN", quantity: it.quantity,
              note: `${to} — order ${order.orderNumber}`,
            },
          });
        }
      }

      const data: Prisma.OrderUpdateInput = {
        status: to,
        version: { increment: 1 },
        updatedById: actor?.sub ?? null,
      };

      // Cash-on-delivery is settled when the parcel is delivered.
      if (to === "DELIVERED" && order.paymentStatus !== "PAID") {
        const codPayment = await tx.payment.findFirst({ where: { orderId: id, provider: "COD" } });
        if (codPayment) {
          data.paymentStatus = "PAID";
          await tx.payment.update({ where: { id: codPayment.id }, data: { status: "PAID" } });
        }
      }

      await tx.order.update({ where: { id }, data });
      await tx.orderEvent.create({
        data: {
          orderId: id, status: to, type: "status",
          message: dto.note?.trim() || STATUS_MESSAGE[to],
          createdById: actor?.sub ?? null,
        },
      });
      return tx.order.findFirst({ where: { id }, include: ORDER_DETAIL_INCLUDE });
    });

    await this.audit.record({
      actor, action: "order.status", entity: "Order", entityId: id,
      after: { status: dto.status }, ip,
    });
    return updated;
  }

  /** Manually set the payment status (e.g. mark a bank transfer as paid). */
  async updatePaymentStatus(id: string, dto: UpdatePaymentStatusDto, actor?: AuthUser, ip?: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!order) throw new NotFoundException("Order not found");
      this.assertVersion(order.version, dto.version);

      await tx.order.update({
        where: { id },
        data: { paymentStatus: dto.paymentStatus, version: { increment: 1 }, updatedById: actor?.sub ?? null },
      });
      const latestPayment = await tx.payment.findFirst({ where: { orderId: id }, orderBy: { createdAt: "desc" } });
      if (latestPayment) {
        await tx.payment.update({ where: { id: latestPayment.id }, data: { status: dto.paymentStatus } });
      }
      await tx.orderEvent.create({
        data: {
          orderId: id, status: order.status, type: "payment",
          message: dto.note?.trim() || `Payment marked ${dto.paymentStatus}`,
          createdById: actor?.sub ?? null,
        },
      });
      return tx.order.findFirst({ where: { id }, include: ORDER_DETAIL_INCLUDE });
    });

    await this.audit.record({
      actor, action: "order.payment", entity: "Order", entityId: id,
      after: { paymentStatus: dto.paymentStatus }, ip,
    });
    return updated;
  }

  /** Append a note to the timeline (customer-visible or internal). */
  async addNote(id: string, dto: AddNoteDto, actor?: AuthUser, ip?: string) {
    const order = await this.prisma.order.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } });
    if (!order) throw new NotFoundException("Order not found");
    const event = await this.prisma.orderEvent.create({
      data: {
        orderId: id, status: order.status, type: "note",
        message: dto.message.trim(), isInternal: dto.isInternal ?? false,
        createdById: actor?.sub ?? null,
      },
    });
    await this.audit.record({
      actor, action: "order.note", entity: "Order", entityId: id,
      after: { isInternal: event.isInternal }, ip,
    });
    return event;
  }

  /** Create or update the shipment (courier, tracking number/url, dates). */
  async updateShipment(id: string, dto: UpdateShipmentDto, actor?: AuthUser, ip?: string) {
    const order = await this.prisma.order.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } });
    if (!order) throw new NotFoundException("Order not found");

    const payload = {
      provider: dto.provider,
      trackingNumber: dto.trackingNumber,
      trackingUrl: dto.trackingUrl,
      status: dto.status,
      shippedAt: dto.shippedAt ? new Date(dto.shippedAt) : undefined,
      deliveredAt: dto.deliveredAt ? new Date(dto.deliveredAt) : undefined,
    };
    const shipment = await this.prisma.shipment.upsert({
      where: { orderId: id },
      create: { orderId: id, ...payload },
      update: payload,
    });
    await this.prisma.orderEvent.create({
      data: {
        orderId: id, status: order.status, type: "shipment",
        message: dto.trackingNumber
          ? `Tracking updated — ${dto.provider ?? "courier"} ${dto.trackingNumber}`
          : "Shipment details updated",
        createdById: actor?.sub ?? null,
      },
    });
    await this.audit.record({
      actor, action: "order.shipment", entity: "Order", entityId: id, after: payload, ip,
    });
    return shipment;
  }

  /** Generate (idempotently) an invoice record for the order. */
  async generateInvoice(id: string, actor?: AuthUser, ip?: string) {
    const order = await this.prisma.order.findFirst({ where: { id, deletedAt: null }, include: { invoice: true } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.invoice) return order.invoice;
    const invoice = await this.prisma.invoice.create({
      data: { orderId: id, number: `INV-${order.orderNumber}` },
    });
    await this.audit.record({
      actor, action: "order.invoice", entity: "Order", entityId: id,
      after: { number: invoice.number }, ip,
    });
    return invoice;
  }

  /**
   * Refund (full or partial) against the order's most recent payment. For RAZORPAY
   * payments the refund is issued at the gateway FIRST (outside the DB transaction),
   * then recorded locally with the gateway refund id — so we never persist a refund
   * that didn't actually happen. COD refunds are recorded locally (settled offline).
   */
  async refund(id: string, dto: RefundDto, actor?: AuthUser, ip?: string) {
    // Pre-flight: validate + decide whether a gateway call is needed (no external I/O in a tx).
    const order = await this.prisma.order.findFirst({ where: { id, deletedAt: null } });
    if (!order) throw new NotFoundException("Order not found");
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: id }, orderBy: { createdAt: "desc" }, include: { refunds: true },
    });
    if (!payment) throw new BadRequestException("No payment on this order to refund");

    const grand = Number(order.grandTotal);
    const alreadyRefunded = payment.refunds.reduce((s, r) => s + Number(r.amount), 0);
    if (alreadyRefunded + dto.amount > grand + 0.001) {
      throw new BadRequestException(`Refund exceeds order total (max ${(grand - alreadyRefunded).toFixed(2)})`);
    }
    const fullyRefunded = alreadyRefunded + dto.amount >= grand - 0.001;
    const newPaymentStatus: PaymentStatus = fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED";

    // Hit the gateway for online (captured) payments.
    let gatewayRefundId: string | null = null;
    if (payment.provider === "RAZORPAY" && payment.providerRef && this.razorpay.configured) {
      const rzp = await this.razorpay.createRefund(payment.providerRef, {
        amount: Math.round(dto.amount * 100),
        notes: { orderNumber: order.orderNumber, reason: dto.reason ?? "" },
      });
      gatewayRefundId = rzp.id;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: { paymentId: payment.id, amount: dto.amount, reason: dto.reason, status: "REFUNDED", providerRef: gatewayRefundId },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { status: newPaymentStatus } });
      await tx.order.update({
        where: { id },
        data: {
          paymentStatus: newPaymentStatus,
          ...(fullyRefunded ? { status: "REFUNDED" } : {}),
          version: { increment: 1 },
          updatedById: actor?.sub ?? null,
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id, status: fullyRefunded ? "REFUNDED" : order.status, type: "refund",
          message: `Refunded ${dto.amount.toFixed(2)} ${order.currency}${gatewayRefundId ? ` (${gatewayRefundId})` : ""}${dto.reason ? ` — ${dto.reason}` : ""}`,
          createdById: actor?.sub ?? null,
        },
      });
      return refund;
    });

    await this.audit.record({
      actor, action: "order.refund", entity: "Order", entityId: id,
      after: { amount: dto.amount, reason: dto.reason, gatewayRefundId }, ip,
    });
    return result;
  }

  /** Revenue, AOV, conversion and status breakdown over a rolling window. */
  async analytics(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const base = { deletedAt: null };
    const scoped = { deletedAt: null, createdAt: { gte: since } };
    const validStatuses: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "DELIVERED"];

    const [totalOrders, periodOrders, revenueAgg, paidAgg, byStatus, byPayment, recent] = await Promise.all([
      this.prisma.order.count({ where: base }),
      this.prisma.order.count({ where: scoped }),
      this.prisma.order.aggregate({
        _sum: { grandTotal: true }, _avg: { grandTotal: true }, _count: true,
        where: { ...scoped, status: { in: validStatuses } },
      }),
      this.prisma.order.aggregate({
        _sum: { grandTotal: true }, _count: true,
        where: { ...scoped, paymentStatus: "PAID" },
      }),
      this.prisma.order.groupBy({ by: ["status"], _count: true, where: base }),
      this.prisma.order.groupBy({ by: ["paymentStatus"], _count: true, where: base }),
      this.prisma.order.findMany({
        where: { ...scoped, status: { in: validStatuses } },
        select: { createdAt: true, grandTotal: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const revenue = Number(revenueAgg._sum.grandTotal ?? 0);
    const paidRevenue = Number(paidAgg._sum.grandTotal ?? 0);
    const aov = Number(revenueAgg._avg.grandTotal ?? 0);
    const paidCount = paidAgg._count as number;
    const conversion = periodOrders ? Math.round((paidCount / periodOrders) * 100) : 0;

    const seriesMap = new Map<string, number>();
    for (const o of recent) {
      const day = o.createdAt.toISOString().slice(0, 10);
      seriesMap.set(day, (seriesMap.get(day) ?? 0) + Number(o.grandTotal));
    }

    return {
      days,
      totalOrders,
      periodOrders,
      revenue: Math.round(revenue * 100) / 100,
      paidRevenue: Math.round(paidRevenue * 100) / 100,
      aov: Math.round(aov * 100) / 100,
      conversion,
      byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count])),
      byPayment: Object.fromEntries(byPayment.map((g) => [g.paymentStatus, g._count])),
      series: [...seriesMap.entries()].map(([date, total]) => ({ date, total: Math.round(total * 100) / 100 })),
    };
  }
}

// ---- Admin controller (full CRUD surface + order-specific operations) ---

@ApiTags("orders")
@Controller({ path: "orders", version: "1" })
export class AdminOrdersController extends CrudController({
  permissions: {
    view: "orders:view",
    create: "orders:edit",
    edit: "orders:edit",
    delete: "orders:delete",
  },
  createDto: CreateOrderAdminDto,
  updateDto: UpdateOrderAdminDto,
  queryDto: OrderQueryDto,
}) {
  constructor(private readonly ordersAdmin: OrdersAdminService) {
    super(ordersAdmin);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Order analytics (revenue, AOV, conversion, status mix)" })
  @RequirePermissions("analytics:view")
  @Get("reports/analytics")
  analytics(@Query() query: AnalyticsQueryDto) {
    return this.ordersAdmin.analytics(query.days ?? 30);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Full order detail (items, timeline, payments, shipment)" })
  @RequirePermissions("orders:view")
  @Get(":id/detail")
  detail(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.ordersAdmin.detail(id);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Advance the order through its lifecycle" })
  @RequirePermissions("orders:edit")
  @Post(":id/status")
  updateStatus(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.updateStatus(id, dto, user, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions("orders:edit")
  @Post(":id/payment")
  updatePayment(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.updatePaymentStatus(id, dto, user, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions("orders:edit")
  @Post(":id/notes")
  addNote(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.addNote(id, dto, user, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions("orders:edit")
  @Patch(":id/shipment")
  updateShipment(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: UpdateShipmentDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.updateShipment(id, dto, user, req.ip);
  }

  @ApiBearerAuth()
  @RequirePermissions("orders:edit")
  @Post(":id/invoice")
  invoice(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.generateInvoice(id, user, req.ip);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Refund (full or partial) — requires orders:refund" })
  @RequirePermissions("orders:refund")
  @Post(":id/refund")
  refund(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.ordersAdmin.refund(id, dto, user, req.ip);
  }
}

@Module({
  imports: [CartModule, PaymentsModule, NotificationsModule],
  controllers: [CheckoutController, AdminOrdersController],
  providers: [OrdersService, OrdersAdminService],
  exports: [OrdersService, OrdersAdminService],
})
export class OrdersModule {}
