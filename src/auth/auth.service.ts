import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { FirebaseService, type FirebaseIdentity } from "../firebase/firebase.service";
import type { AuthUser } from "./decorators";
import { LoginDto, RegisterDto } from "./dto";
import { generateSecret, otpauthUrl, verifyToken } from "./totp";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private firebase: FirebaseService,
  ) {}

  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private async buildAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      },
    });
    const roles = user.roles.map((r) => r.role.slug);
    const permissions = [
      ...new Set(
        user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)),
      ),
    ];
    return { sub: user.id, email: user.email, type: user.type, roles, permissions };
  }

  private async issueTokens(payload: AuthUser, meta?: { ip?: string; ua?: string }) {
    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: Number(process.env.JWT_ACCESS_TTL ?? 900),
    });
    const refreshToken = randomUUID() + "." + randomUUID();
    const ttl = Number(process.env.JWT_REFRESH_TTL ?? 1_209_600);
    await this.prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + ttl * 1000),
        ip: meta?.ip,
        userAgent: meta?.ua,
      },
    });
    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException("Email already registered");

    const passwordHash = await argon2.hash(dto.password);
    const customerRole = await this.prisma.role.findUnique({ where: { slug: "customer" } });

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        passwordHash,
        type: "CUSTOMER",
        roles: customerRole ? { create: { roleId: customerRole.id } } : undefined,
      },
    });
    const payload = await this.buildAuthUser(user.id);
    const tokens = await this.issueTokens(payload);
    return { user: this.publicUser(user), ...tokens };
  }

  async login(dto: LoginDto, meta?: { ip?: string; ua?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Administrators authenticate exclusively through Firebase (the admin portal),
    // never with a local password — this closes the door on any legacy admin password.
    if (user?.type === "STAFF") {
      throw new UnauthorizedException("Administrators must sign in through the admin portal.");
    }
    const ok = user && user.passwordHash && (await argon2.verify(user.passwordHash, dto.password));
    if (user) {
      await this.prisma.loginHistory.create({
        data: { userId: user.id, success: !!ok, ip: meta?.ip, userAgent: meta?.ua },
      });
    }
    if (!user || !ok) throw new UnauthorizedException("Invalid credentials");
    if (user.isBlocked) throw new UnauthorizedException("Account is blocked");
    if (!user.isActive) throw new UnauthorizedException("Account is deactivated");

    // Two-factor challenge (only for accounts that enabled it — others unaffected).
    if (user.twoFactorEnabled) {
      if (!dto.twoFactorCode) {
        throw new UnauthorizedException({ message: "Two-factor code required", twoFactorRequired: true });
      }
      if (!user.twoFactorSecret || !verifyToken(user.twoFactorSecret, dto.twoFactorCode)) {
        throw new UnauthorizedException("Invalid two-factor code");
      }
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const payload = await this.buildAuthUser(user.id);
    const tokens = await this.issueTokens(payload, meta);
    return { user: this.publicUser(user), ...tokens };
  }

  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    // Re-check the account on every refresh so revoking admin access (disable/
    // reject/block) ends the session within one access-token lifetime.
    const account = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
    if (account.isBlocked || !account.isActive) {
      throw new UnauthorizedException("Account is not active");
    }
    if (account.type === "STAFF" && account.adminStatus !== "APPROVED") {
      throw new UnauthorizedException("Administrator access is not active");
    }
    // Rotate: revoke the old token, issue a new pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const payload = await this.buildAuthUser(stored.userId);
    return this.issueTokens(payload);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(refreshToken) },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const auth = await this.buildAuthUser(userId);
    return { ...this.publicUser(user), roles: auth.roles, permissions: auth.permissions, twoFactorEnabled: user.twoFactorEnabled };
  }

  // ---- Firebase admin authentication ----

  private async assignRole(userId: string, roleSlug: string) {
    const role = await this.prisma.role.findUnique({ where: { slug: roleSlug } });
    if (!role) return;
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      update: {},
      create: { userId, roleId: role.id },
    });
  }

  /**
   * Resolve the local User for a verified Firebase identity, linking an existing
   * account by email on first Firebase sign-in, or creating one otherwise.
   */
  private async resolveFirebaseUser(identity: FirebaseIdentity) {
    let user = await this.prisma.user.findUnique({ where: { firebaseUid: identity.uid } });
    if (!user) {
      const byEmail = await this.prisma.user.findUnique({ where: { email: identity.email } });
      if (byEmail) {
        user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: {
            firebaseUid: identity.uid,
            emailVerified: byEmail.emailVerified || identity.emailVerified,
          },
        });
      }
    }
    if (!user) {
      const parts = (identity.name ?? identity.email.split("@")[0]).trim().split(/\s+/);
      user = await this.prisma.user.create({
        data: {
          email: identity.email,
          firebaseUid: identity.uid,
          firstName: parts[0] || "Admin",
          lastName: parts.slice(1).join(" ") || "User",
          type: "CUSTOMER",
          emailVerified: identity.emailVerified,
          adminStatus: "NONE",
        },
      });
    }
    return user;
  }

  /** Revoke an account's admin access: strip roles, mark not-admin, kill sessions. */
  private async revokeAdmin(userId: string) {
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { type: "CUSTOMER", adminStatus: "NONE" },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /**
   * Exchange a verified Firebase ID token for a backend session. Authorization is
   * decided by the Firestore `admins` collection (a per-email `approved` flag that
   * only an admin can set in the Firebase console) — read server-side via the
   * user's own token, never trusted from the client. A session (app JWT + refresh)
   * is issued ONLY when `approved === true`; otherwise `NOT_APPROVED` is returned
   * and any prior admin access is revoked.
   */
  async firebaseSession(idToken: string, meta?: { ip?: string; ua?: string }) {
    const identity = await this.firebase.verifyIdToken(idToken);
    const user = await this.resolveFirebaseUser(identity);

    if (user.isBlocked) throw new ForbiddenException("Account is blocked");

    // Authorization gate. Two sources, either grants access:
    //  1) ADMIN_EMAILS env allowlist (owner-controlled, no Firestore rules needed) —
    //     the guaranteed path and bootstrap mechanism.
    //  2) Firestore `admins` doc (approved flag) keyed by uid or email.
    const allowlist = (process.env.ADMIN_EMAILS ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowlisted = allowlist.includes(identity.email);
    const approval = allowlisted
      ? { approved: true, role: process.env.FIREBASE_DEFAULT_ADMIN_ROLE || "super_admin" }
      : await this.firebase.getAdminApproval(idToken, identity.uid, identity.email);

    // Diagnostic (safe to leave on): shows why access was/ wasn't granted.
    this.logger.log(
      `firebaseSession email="${identity.email}" uid=${identity.uid} ` +
        `allowlistCount=${allowlist.length} allowlisted=${allowlisted} ` +
        `firestoreApproved=${allowlisted ? "n/a" : approval?.approved === true} ` +
        `=> ${approval?.approved ? "APPROVED" : "NOT_APPROVED"}`,
    );

    if (!approval?.approved) {
      // Not (or no longer) an approved admin — ensure no lingering access.
      if (user.type === "STAFF" || user.adminStatus === "APPROVED") {
        await this.revokeAdmin(user.id);
      }
      return { status: "NOT_APPROVED" as const, user: this.publicUser(user) };
    }

    // Approved: ensure STAFF + the granted role, then issue a session.
    const roleSlug = approval.role || process.env.FIREBASE_DEFAULT_ADMIN_ROLE || "super_admin";
    await this.prisma.user.update({
      where: { id: user.id },
      data: { type: "STAFF", adminStatus: "APPROVED", adminReviewedAt: new Date(), lastLoginAt: new Date() },
    });
    await this.assignRole(user.id, roleSlug);
    await this.prisma.loginHistory.create({
      data: { userId: user.id, success: true, ip: meta?.ip, userAgent: meta?.ua },
    });
    const payload = await this.buildAuthUser(user.id);
    const tokens = await this.issueTokens(payload, meta);
    return { status: "APPROVED" as const, user: this.publicUser(user), ...tokens };
  }

  // ---- Two-factor (TOTP) self-enrollment ----

  /** Generate a fresh secret + otpauth URL. Stored but not active until verified. */
  async twoFactorSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Verify the first code to switch 2FA on. */
  async twoFactorEnable(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecret) throw new BadRequestException("Start 2FA setup first");
    if (!verifyToken(user.twoFactorSecret, code)) throw new BadRequestException("Invalid code");
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    return { twoFactorEnabled: true };
  }

  /** Disable 2FA (requires a valid current code). */
  async twoFactorDisable(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) throw new BadRequestException("2FA is not enabled");
    if (!verifyToken(user.twoFactorSecret, code)) throw new BadRequestException("Invalid code");
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
    return { twoFactorEnabled: false };
  }

  private publicUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    type: string;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      type: user.type,
    };
  }
}
