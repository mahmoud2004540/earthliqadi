import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createListingSchema,
  listingDecisionSchema,
  listingQuerySchema,
  uuidParamSchema,
  type ListingRequestDto,
} from '@platform/shared';
import type { z } from 'zod';
import { AccessPolicy } from '../access/access.guard';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ListingsService } from './listings.service';

type Id = z.infer<typeof uuidParamSchema>;

/** Listing request board (ADR-0026). Reads are public; writes need a signed-in account. */
@ApiTags('listings')
@Controller({ path: 'listings', version: '1' })
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Public()
  @Get()
  async list(
    @Query(new ZodValidationPipe(listingQuerySchema)) q: z.infer<typeof listingQuerySchema>,
  ): Promise<{ requests: ListingRequestDto[] }> {
    return { requests: await this.listings.list(q.status) };
  }

  /** Ids of the caller's own requests and votes. */
  @Get('mine')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  mine(@CurrentAuth() auth: AuthContext): Promise<{ authored: string[]; voted: string[] }> {
    return this.listings.mine(auth.user.id);
  }

  @Public()
  @Get(':id')
  get(@Param(new ZodValidationPipe(uuidParamSchema)) p: Id): Promise<ListingRequestDto> {
    return this.listings.get(p.id);
  }

  @Post()
  @AccessPolicy('manage')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(createListingSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createListingSchema)) body: z.infer<typeof createListingSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ListingRequestDto> {
    return this.listings.create(auth.user.id, body, ctx);
  }

  @Post(':id/vote')
  @HttpCode(HttpStatus.OK)
  @AccessPolicy('manage')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  vote(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: Id,
  ): Promise<ListingRequestDto> {
    return this.listings.vote(auth.user.id, p.id);
  }

  @Delete(':id/vote')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  unvote(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: Id,
  ): Promise<ListingRequestDto> {
    return this.listings.unvote(auth.user.id, p.id);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  withdraw(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: Id,
    @ReqContext() ctx: RequestContext,
  ): Promise<ListingRequestDto> {
    return this.listings.withdraw(auth.user.id, p.id, ctx);
  }
}

/** Staff: decide listing requests against the published criteria. */
@ApiTags('admin')
@Controller({ path: 'admin/listings', version: '1' })
export class AdminListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.MARKETS_CONFIGURE)
  @ApiZodBody(listingDecisionSchema)
  decide(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: Id,
    @Body(new ZodValidationPipe(listingDecisionSchema)) body: z.infer<typeof listingDecisionSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<ListingRequestDto> {
    return this.listings.decide(auth.user.id, p.id, body, ctx);
  }
}

@Module({
  controllers: [ListingsController, AdminListingsController],
  providers: [ListingsService],
})
export class ListingsModule {}
