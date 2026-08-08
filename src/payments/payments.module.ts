import { Module } from "@nestjs/common";
import {
  BadRequestException, Body, Controller, ForbiddenException, Headers, Injectable, Logger,
  NotFoundException, Param, Post, Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { CurrentUser, Public, type AuthUser } from "../auth/decorators";

const round2 = (n: number) => Math.round(n * 100) / 100;

// =========================================================================
// Razorpay gateway client — REST + HMAC signatures. No SDK dependency.
// Fully config-driven: with no keys it reports `configured=false` and callers
// degrade gracefully (order stays PENDING, admin can settle manually).
// =========================================================================

@Injectable()
export class RazorpayService {
  private readonly logger = new Logger("Razorpay");
  private readonly keyId = process.env.RAZORPAY_KEY_ID ?? "";
  private readonly keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  private readonly webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  private readonly base = "https://api.razorpay.com/v1";

  get configured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }
  get webhookConfigured(): boolean {
    return Boolean(this.webhookSecret);
  }
  get publicKeyId(): string {
    return this.keyId;
  }

  /** Constant-time comparison of two hex digests. */
  private safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  /** Razorpay checkout handshake: HMAC_SHA256(order_id|payment_id, keySecret). */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.keySecret || !signature) return false;
    const expected = crypto
      .createHmac("sha256", this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return this.safeEqual(expected, signature);
  }

  /** Webhook authenticity: HMAC_SHA256(rawBody, webhookSecret). */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
      .digest("hex");
    return this.safeEqual(expected, signature);
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.configured) throw new BadRequestException("Razorpay is not configured");
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = (json as { error?: { description?: string } })?.error?.description ?? `Razorpay ${res.status}`;
      this.logger.error(`${method} ${path} -> ${res.status} ${msg}`);
      throw new BadRequestException(`Payment gateway error: ${msg}`);
    }
    return json as T;
  }

  /** Create a Razorpay order (amount in paise). */
  createOrder(input: { amount: number; currency: string; receipt: string; notes?: Record<string, string> }) {
    return this.call<{ id: string; amount: number; currency: string; status: string }>(
      "POST", "/orders",
      { amount: input.amount, currency: input.currency, receipt: input.receipt, notes: input.notes, payment_capture: 1 },
    );
  }

  /** Issue a refund against a captured payment (amount in paise; omit for full). */
  createRefund(paymentId: string, input: { amount?: number; notes?: Record<string, string> }) {
    return this.call<{ id: string; amount: number; status: string }>(
      "POST", `/payments/${paymentId}/refund`,
      { amount: input.amount, notes: input.notes },
    );
  }
}

// ---- DTOs ---------------------------------------------------------------

class CreatePaymentDto {
  @ApiProperty() @IsString() @MinLength(1) orderId!: string;
}

class VerifyPaymentDto {
  @ApiProperty() @IsString() razorpay_order_id!: string;
  @ApiProperty() @IsString() razorpay_payment_id!: string;
  @ApiProperty() @IsString() razorpay_signature!: string;
}

export interface CheckoutParams {
  configured: boolean;
  gateway?: "razorpay";
  keyId?: string;
  providerOrder?: string;
  amount?: number;
  currency?: string;
  orderId?: string;
  orderNumber?: string;
  name?: string;
  email?: string;
  contact?: string;
}

// ---- Order-aware payment operations -------------------------------------

@Injectable()
export class PaymentService {
  private readonly logger = new Logger("PaymentService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly audit: AuditService,
  ) {}

  private async loadOwnedOrder(userId: string, ref: string) {
    const order = await this.prisma.order.findFirst({
      where: { userId, deletedAt: null, OR: [{ id: ref }, { orderNumber: ref }] },
      include: { payments: { orderBy: { createdAt: "desc" } }, user: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  /** Create a gateway order for an unpaid online order → checkout params for the client. */
  async createForOrder(userId: string, ref: string): Promise<CheckoutParams> {
    const order = await this.loadOwnedOrder(userId, ref);
    if (order.paymentStatus === "PAID") throw new BadRequestException("Order is already paid");

    const payment = order.payments.find((p) => p.provider === "RAZORPAY");
    if (!payment) throw new BadRequestException("This order is not an online-payment order");

    if (!this.razorpay.configured) {
      // Graceful degradation — no keys in this environment.
      return { configured: false, orderId: order.id, orderNumber: order.orderNumber };
    }

    const amount = Math.round(Number(order.grandTotal) * 100);
    const rzp = await this.razorpay.createOrder({
      amount,
      currency: order.currency,
      receipt: order.orderNumber,
      notes: { orderId: order.id, orderNumber: order.orderNumber },
    });

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerOrder: rzp.id, status: "PENDING" },
    });

    return {
      configured: true,
      gateway: "razorpay",
      keyId: this.razorpay.publicKeyId,
      providerOrder: rzp.id,
      amount,
      currency: order.currency,
      orderId: order.id,
      orderNumber: order.orderNumber,
      name: [order.user?.firstName, order.user?.lastName].filter(Boolean).join(" ") || undefined,
      email: order.email,
      contact: order.user?.phone ?? undefined,
    };
  }

  /** Verify the checkout handshake and settle the order. Idempotent. */
  async confirm(userId: string, dto: VerifyPaymentDto) {
    if (!this.razorpay.verifyPaymentSignature(dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature)) {
      throw new BadRequestException("Invalid payment signature");
    }
    const payment = await this.prisma.payment.findFirst({
      where: { providerOrder: dto.razorpay_order_id, order: { userId, deletedAt: null } },
      include: { order: true },
    });
    if (!payment) throw new NotFoundException("Payment not found");

    if (payment.status === "PAID") {
      return { status: "PAID", orderNumber: payment.order.orderNumber, alreadyProcessed: true };
    }

    const order = await this.settlePaid(payment.id, payment.orderId, dto.razorpay_payment_id, dto.razorpay_signature);
    await this.audit.record({
      actor: { sub: userId, email: payment.order.email } as AuthUser,
      action: "payment.captured", entity: "Order", entityId: payment.orderId,
      after: { paymentId: dto.razorpay_payment_id },
    });
    return { status: "PAID", orderNumber: order.orderNumber };
  }

  /** Mark a payment captured + confirm the order + timeline. Shared by confirm() and webhook. */
  private async settlePaid(paymentId: string, orderId: string, providerRef: string, signature?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "PAID", providerRef, signature: signature ?? null },
      });
      const current = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const order = await tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: "PAID",
          status: current.status === "PENDING" ? "CONFIRMED" : current.status,
          version: { increment: 1 },
        },
      });
      await tx.orderEvent.create({
        data: { orderId, status: order.status, type: "payment", message: `Payment received (${providerRef})` },
      });
      return order;
    });
  }

  /** Re-initiate payment for an unpaid online order (failed-payment recovery). */
  async retry(userId: string, ref: string): Promise<CheckoutParams> {
    const order = await this.loadOwnedOrder(userId, ref);
    if (order.paymentStatus === "PAID") throw new BadRequestException("Order is already paid");
    return this.createForOrder(userId, order.id);
  }

  /** Razorpay webhook — verified via HMAC over the raw body. Idempotent. @Public. */
  async webhook(rawBody: Buffer | string | undefined, signature: string | undefined) {
    if (!this.razorpay.webhookConfigured) {
      this.logger.warn("Webhook received but RAZORPAY_WEBHOOK_SECRET is not set — ignoring");
      return { received: false, reason: "not-configured" };
    }
    if (!rawBody || !signature || !this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new ForbiddenException("Invalid webhook signature");
    }
    const event = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as {
      event: string;
      payload: { payment?: { entity: { id: string; order_id: string; amount: number } };
                 refund?: { entity: { id: string; payment_id: string; amount: number } } };
    };

    switch (event.event) {
      case "payment.captured": {
        const p = event.payload.payment!.entity;
        const payment = await this.prisma.payment.findFirst({ where: { providerOrder: p.order_id } });
        if (payment && payment.status !== "PAID") {
          await this.settlePaid(payment.id, payment.orderId, p.id);
        }
        break;
      }
      case "payment.failed": {
        const p = event.payload.payment!.entity;
        const payment = await this.prisma.payment.findFirst({ where: { providerOrder: p.order_id } });
        if (payment && payment.status !== "PAID") {
          await this.prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", providerRef: p.id } });
          await this.prisma.orderEvent.create({
            data: { orderId: payment.orderId, status: "PENDING", type: "payment", message: "Payment attempt failed" },
          });
        }
        break;
      }
      case "refund.processed":
      case "refund.created": {
        const r = event.payload.refund!.entity;
        const payment = await this.prisma.payment.findFirst({ where: { providerRef: r.payment_id }, include: { refunds: true } });
        if (payment && !payment.refunds.some((x) => x.providerRef === r.id)) {
          await this.prisma.refund.create({
            data: { paymentId: payment.id, amount: round2(r.amount / 100), status: "REFUNDED", providerRef: r.id },
          });
        }
        break;
      }
      default:
        this.logger.log(`Unhandled webhook event: ${event.event}`);
    }
    return { received: true };
  }
}

// ---- Controllers --------------------------------------------------------

@ApiTags("account")
@ApiBearerAuth()
@Controller({ path: "account/payments", version: "1" })
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @ApiOperation({ summary: "Create a gateway order for an unpaid order → checkout params" })
  @Post("create")
  create(@Body() dto: CreatePaymentDto, @CurrentUser() u: AuthUser) {
    return this.payments.createForOrder(u.sub, dto.orderId);
  }

  @ApiOperation({ summary: "Verify the Razorpay checkout handshake and settle the order" })
  @Post("verify")
  verify(@Body() dto: VerifyPaymentDto, @CurrentUser() u: AuthUser) {
    return this.payments.confirm(u.sub, dto);
  }

  @ApiOperation({ summary: "Retry payment for an unpaid order (failed-payment recovery)" })
  @Post(":ref/retry")
  retry(@Param("ref") ref: string, @CurrentUser() u: AuthUser) {
    return this.payments.retry(u.sub, ref);
  }
}

@ApiTags("payments")
@Controller({ path: "payments/webhook", version: "1" })
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentService) {}

  @Public()
  @ApiOperation({ summary: "Razorpay webhook (HMAC-verified over raw body)" })
  @Post()
  webhook(@Req() req: RawBodyRequest<Request>, @Headers("x-razorpay-signature") signature: string) {
    return this.payments.webhook(req.rawBody, signature);
  }
}

@Module({
  controllers: [PaymentController, PaymentWebhookController],
  providers: [RazorpayService, PaymentService],
  exports: [RazorpayService, PaymentService],
})
export class PaymentsModule {}
