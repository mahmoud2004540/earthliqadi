import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  emailOnlySchema,
  loginMfaSchema,
  loginSchema,
  walletLoginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type LoginResultDto,
} from '@platform/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AuthRateLimit, Public } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { AuthContext } from './auth-context';
import { AuthService, type LoginOutcome } from './auth.service';
import { clearSessionCookie, setCsrfCookie, setSessionCookie } from './cookies';
import { CsrfService } from './csrf.service';
import { CurrentAuth } from './current-auth.decorator';

const ACCEPTED = {
  status: 'accepted',
  message: 'If the request can be processed, you will receive an email shortly.',
} as const;

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Sign-In with Ethereum, step 1: a single-use nonce and the expected domain/URI. */
  @Public()
  @AuthRateLimit()
  @Get('wallet/nonce')
  async walletNonce(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.auth.walletNonce();
  }

  /** Step 2: the EIP-4361 message and its personal_sign signature. Creates the account on first use. */
  @Public()
  @AuthRateLimit()
  @Post('wallet/login')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(walletLoginSchema)
  async walletLogin(
    @Body(new ZodValidationPipe(walletLoginSchema)) body: z.infer<typeof walletLoginSchema>,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    return this.finish(await this.auth.walletLogin(body, ctx), res);
  }

  @Public()
  @Get('csrf')
  @ApiOperation({ summary: 'Issue a CSRF token (also set as an httpOnly cookie)' })
  issueCsrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = this.csrf.issue();
    setCsrfCookie(res, this.config, token);
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: token };
  }

  @Public()
  @AuthRateLimit()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiZodBody(registerSchema)
  @ApiOperation({ summary: 'Register (response is identical whether or not the email exists)' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<typeof ACCEPTED> {
    await this.auth.register(body, ctx);
    return ACCEPTED;
  }

  @Public()
  @AuthRateLimit()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(verifyEmailSchema)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ status: 'verified' }> {
    await this.auth.verifyEmail(body.token, ctx);
    return { status: 'verified' };
  }

  @Public()
  @AuthRateLimit()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiZodBody(emailOnlySchema)
  async resendVerification(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
  ): Promise<typeof ACCEPTED> {
    await this.auth.resendVerification(body.email);
    return ACCEPTED;
  }

  @Public()
  @AuthRateLimit()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(loginSchema)
  @ApiOperation({ summary: 'Password login; returns mfa_required when TOTP is enabled' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    return this.finish(await this.auth.login(body, ctx), res);
  }

  @Public()
  @AuthRateLimit()
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(loginMfaSchema)
  async loginMfa(
    @Body(new ZodValidationPipe(loginMfaSchema)) body: z.infer<typeof loginMfaSchema>,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResultDto> {
    return this.finish(await this.auth.completeMfaLogin(body.challengeId, body.code, ctx), res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @ReqContext() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth.sessionId, auth.user.id, ctx);
    clearSessionCookie(res, this.config);
  }

  @Public()
  @AuthRateLimit()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiZodBody(emailOnlySchema)
  async forgotPassword(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<typeof ACCEPTED> {
    await this.auth.forgotPassword(body.email, ctx);
    return ACCEPTED;
  }

  @Public()
  @AuthRateLimit()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(resetPasswordSchema)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ status: 'password_reset' }> {
    await this.auth.resetPassword(body.token, body.newPassword, ctx);
    return { status: 'password_reset' };
  }

  private finish(outcome: LoginOutcome, res: Response): LoginResultDto {
    if (outcome.kind === 'authenticated') setSessionCookie(res, this.config, outcome.sessionToken);
    res.setHeader('Cache-Control', 'no-store');
    return outcome.result;
  }
}
