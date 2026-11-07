import { Body, Controller, Get, HttpCode, HttpStatus, Module, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createIncidentSchema,
  incidentUpdateSchema,
  uuidParamSchema,
  type IncidentDto,
  type StatusDto,
} from '@platform/shared';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions, RequireStepUp } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ReqContext, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketDataModule } from '../market-data/market-data.module';
import { StatusService } from './status.service';

@ApiTags('status')
@Controller({ path: 'status', version: '1' })
export class StatusController {
  constructor(private readonly status: StatusService) {}

  /** Component states and incident reports (ADR-0030). */
  @Public()
  @Get()
  get(): Promise<StatusDto> {
    return this.status.status();
  }
}

/** Staff: open and update incident reports. Updates are append-only. */
@ApiTags('admin')
@Controller({ path: 'admin/incidents', version: '1' })
export class AdminIncidentsController {
  constructor(private readonly status: StatusService) {}

  @Post()
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @ApiZodBody(createIncidentSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createIncidentSchema)) body: z.infer<typeof createIncidentSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<IncidentDto> {
    return this.status.create(auth.user.id, body, ctx);
  }

  @Post(':id/updates')
  @HttpCode(HttpStatus.OK)
  @RequireStepUp()
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @ApiZodBody(incidentUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(uuidParamSchema)) p: z.infer<typeof uuidParamSchema>,
    @Body(new ZodValidationPipe(incidentUpdateSchema)) body: z.infer<typeof incidentUpdateSchema>,
    @ReqContext() ctx: RequestContext,
  ): Promise<IncidentDto> {
    return this.status.addUpdate(auth.user.id, p.id, body, ctx);
  }
}

@Module({
  imports: [MarketDataModule],
  controllers: [StatusController, AdminIncidentsController],
  providers: [StatusService],
})
export class StatusModule {}
