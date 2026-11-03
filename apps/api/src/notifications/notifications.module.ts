import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, markNotificationsReadSchema, type NotificationDto } from '@platform/shared';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { RequirePermissions } from '../common/decorators';
import { ApiZodBody } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { NotificationsService } from './notifications.service';

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

@ApiTags('notifications')
@Controller({ path: 'me/notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_READ)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>,
  ): Promise<{ items: NotificationDto[]; unread: number }> {
    return this.notifications.list(auth.user.id, q.limit);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ACCOUNT_SELF_MANAGE)
  @ApiZodBody(markNotificationsReadSchema)
  async read(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(markNotificationsReadSchema))
    body: z.infer<typeof markNotificationsReadSchema>,
  ): Promise<{ updated: number }> {
    return { updated: await this.notifications.markRead(auth.user.id, body.ids ?? 'all') };
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
