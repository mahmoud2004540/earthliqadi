import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createSubAccountSchema,
  subTransferSchema,
  type SubAccountDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { AppError } from '../common/app-error';
import { RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SubAccountsService } from './sub-accounts.service';

/** Sub-account management (ADR-0017). Session only; never on behalf of a sub-account. */
@ApiTags('sub-accounts')
@Controller({ path: 'me/sub-accounts', version: '1' })
export class SubAccountsController {
  constructor(private readonly subs: SubAccountsService) {}

  private parent(auth: AuthContext): string {
    if (auth.actingAsSubAccount) throw AppError.forbidden('Use the main account for this');
    return auth.user.id;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(@CurrentAuth() auth: AuthContext): Promise<{ subAccounts: SubAccountDto[] }> {
    return { subAccounts: await this.subs.list(this.parent(auth)) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(createSubAccountSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSubAccountSchema))
    body: z.infer<typeof createSubAccountSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<SubAccountDto> {
    return this.subs.create(this.parent(auth), body.label, ctx);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.TRADING_TRADE)
  @ApiZodBody(subTransferSchema)
  transfer(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(subTransferSchema)) body: z.infer<typeof subTransferSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<{ entryId: string; replayed: boolean }> {
    return this.subs.transfer(this.parent(auth), body, ctx);
  }
}
