import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { FirebaseSessionDto, LoginDto, RefreshDto, RegisterDto, TwoFactorCodeDto } from "./dto";
import { CurrentUser, Public, AuthUser } from "./decorators";

/** Tight per-route limit to blunt credential brute-forcing (overrides the global 120/min). */
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@ApiTags("auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private meta(req: Request) {
    return { ip: req.ip, ua: req.headers["user-agent"] };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("login")
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.meta(req));
  }

  /** Exchange a Firebase ID token for an admin session (issued only if approved in Firestore). */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post("firebase/session")
  firebaseSession(@Body() dto: FirebaseSessionDto, @Req() req: Request) {
    return this.auth.firebaseSession(dto.idToken, this.meta(req));
  }

  @Public()
  @Post("refresh")
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post("logout")
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }

  // ---- Two-factor (self-service for the authenticated user) ----

  @ApiBearerAuth()
  @Post("2fa/setup")
  twoFactorSetup(@CurrentUser() user: AuthUser) {
    return this.auth.twoFactorSetup(user.sub);
  }

  @ApiBearerAuth()
  @Post("2fa/enable")
  twoFactorEnable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.auth.twoFactorEnable(user.sub, dto.code);
  }

  @ApiBearerAuth()
  @Post("2fa/disable")
  twoFactorDisable(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.auth.twoFactorDisable(user.sub, dto.code);
  }
}
