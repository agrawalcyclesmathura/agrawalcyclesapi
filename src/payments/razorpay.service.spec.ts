import * as crypto from "node:crypto";
import { RazorpayService } from "./payments.module";

/** Build the signature Razorpay would send for the checkout handshake. */
const paymentSig = (secret: string, orderId: string, paymentId: string) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

const webhookSig = (secret: string, body: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("RazorpayService signatures", () => {
  const KEY_SECRET = "test_secret_key";
  const WEBHOOK_SECRET = "test_webhook_secret";
  let svc: RazorpayService;

  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_123";
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    svc = new RazorpayService();
  });

  describe("configuration flags", () => {
    it("reports configured when key id + secret are present", () => {
      expect(svc.configured).toBe(true);
      expect(svc.webhookConfigured).toBe(true);
      expect(svc.publicKeyId).toBe("rzp_test_123");
    });

    it("reports not-configured when keys are missing", () => {
      process.env.RAZORPAY_KEY_ID = "";
      process.env.RAZORPAY_KEY_SECRET = "";
      process.env.RAZORPAY_WEBHOOK_SECRET = "";
      const bare = new RazorpayService();
      expect(bare.configured).toBe(false);
      expect(bare.webhookConfigured).toBe(false);
    });
  });

  describe("verifyPaymentSignature", () => {
    const orderId = "order_ABC123";
    const paymentId = "pay_XYZ789";

    it("accepts a valid signature", () => {
      const sig = paymentSig(KEY_SECRET, orderId, paymentId);
      expect(svc.verifyPaymentSignature(orderId, paymentId, sig)).toBe(true);
    });

    it("rejects a tampered signature", () => {
      const sig = paymentSig(KEY_SECRET, orderId, paymentId);
      expect(svc.verifyPaymentSignature(orderId, paymentId, sig.replace(/.$/, "0"))).toBe(false);
    });

    it("rejects a signature for a different payment id (replay)", () => {
      const sig = paymentSig(KEY_SECRET, orderId, paymentId);
      expect(svc.verifyPaymentSignature(orderId, "pay_OTHER", sig)).toBe(false);
    });

    it("rejects a signature made with the wrong secret", () => {
      const sig = paymentSig("wrong_secret", orderId, paymentId);
      expect(svc.verifyPaymentSignature(orderId, paymentId, sig)).toBe(false);
    });

    it("rejects empty/missing signatures", () => {
      expect(svc.verifyPaymentSignature(orderId, paymentId, "")).toBe(false);
    });

    it("rejects everything when not configured", () => {
      process.env.RAZORPAY_KEY_SECRET = "";
      const bare = new RazorpayService();
      const sig = paymentSig(KEY_SECRET, orderId, paymentId);
      expect(bare.verifyPaymentSignature(orderId, paymentId, sig)).toBe(false);
    });
  });

  describe("verifyWebhookSignature", () => {
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });

    it("accepts a valid signature over the raw body (string)", () => {
      expect(svc.verifyWebhookSignature(body, webhookSig(WEBHOOK_SECRET, body))).toBe(true);
    });

    it("accepts a valid signature over the raw body (Buffer)", () => {
      expect(svc.verifyWebhookSignature(Buffer.from(body), webhookSig(WEBHOOK_SECRET, body))).toBe(true);
    });

    it("rejects when the body is altered after signing", () => {
      const sig = webhookSig(WEBHOOK_SECRET, body);
      expect(svc.verifyWebhookSignature(body + " ", sig)).toBe(false);
    });

    it("rejects a signature made with the wrong webhook secret", () => {
      expect(svc.verifyWebhookSignature(body, webhookSig("nope", body))).toBe(false);
    });

    it("rejects when webhook secret is not configured", () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = "";
      const bare = new RazorpayService();
      expect(bare.verifyWebhookSignature(body, webhookSig(WEBHOOK_SECRET, body))).toBe(false);
    });
  });
});
