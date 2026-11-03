import {
  Body,
  Controller,
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
  announcementSchema,
  createTicketSchema,
  ticketReplySchema,
  type AnnouncementDto,
  type TicketDto,
} from '@platform/shared';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { Public, RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SupportService } from './support.service';

const idParam = z.object({ id: z.uuid() });
const queueQuery = z.object({
  status: z.enum(['open', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

@ApiTags('support')
@Controller({ path: 'me/tickets', version: '1' })
export class TicketsController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  async list(@CurrentAuth() auth: AuthContext): Promise<{ tickets: TicketDto[] }> {
    return { tickets: await this.support.listOwn(auth.user.id) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(createTicketSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createTicketSchema)) body: z.infer<typeof createTicketSchema>,
  ): Promise<TicketDto> {
    return this.support.create(auth.user.id, body.subject, body.body);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
  ): Promise<TicketDto> {
    return this.support.getOwn(auth.user.id, p.id);
  }

  @Post(':id/messages')
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(ticketReplySchema)
  reply(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(ticketReplySchema)) body: z.infer<typeof ticketReplySchema>,
  ): Promise<TicketDto> {
    return this.support.reply(p.id, auth.user.id, body.body, false);
  }
}

@ApiTags('admin')
@Controller({ path: 'admin/tickets', version: '1' })
export class StaffTicketsController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SUPPORT_TICKETS_MANAGE)
  async queue(
    @Query(new ZodValidationPipe(queueQuery)) q: z.infer<typeof queueQuery>,
  ): Promise<{ tickets: TicketDto[] }> {
    return { tickets: await this.support.queue(q.status, q.limit) };
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.SUPPORT_TICKETS_MANAGE)
  get(@Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>): Promise<TicketDto> {
    return this.support.staffView(p.id);
  }

  @Post(':id/messages')
  @RequirePermissions(PERMISSIONS.SUPPORT_TICKETS_MANAGE)
  @ApiZodBody(ticketReplySchema)
  reply(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
    @Body(new ZodValidationPipe(ticketReplySchema)) body: z.infer<typeof ticketReplySchema>,
  ): Promise<TicketDto> {
    return this.support.reply(p.id, auth.user.id, body.body, true);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SUPPORT_TICKETS_MANAGE)
  close(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(idParam)) p: z.infer<typeof idParam>,
  ): Promise<TicketDto> {
    return this.support.close(p.id, auth.user.id);
  }
}

@ApiTags('announcements')
@Controller({ path: 'announcements', version: '1' })
export class AnnouncementsController {
  constructor(private readonly support: SupportService) {}

  @Public()
  @Get()
  async list(
    @Query(new ZodValidationPipe(limitQuery)) q: z.infer<typeof limitQuery>,
  ): Promise<{ announcements: AnnouncementDto[] }> {
    return { announcements: await this.support.announcements(q.limit) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ANNOUNCEMENTS_MANAGE)
  @ApiZodBody(announcementSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(announcementSchema)) body: z.infer<typeof announcementSchema>,
  ): Promise<AnnouncementDto> {
    return this.support.announce(body.title, body.body, auth.user.id);
  }
}

@Module({
  controllers: [TicketsController, StaffTicketsController, AnnouncementsController],
  providers: [SupportService],
})
export class SupportModule {}
