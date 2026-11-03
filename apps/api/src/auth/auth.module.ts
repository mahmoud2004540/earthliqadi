import { Module } from '@nestjs/common';
import { PasswordService } from '../security/password.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfService } from './csrf.service';
import { CsrfGuard, PermissionsGuard, SessionAuthGuard } from './guards';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    CsrfService,
    MfaService,
    PasswordService,
    CsrfGuard,
    SessionAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    AuthService,
    SessionService,
    CsrfService,
    MfaService,
    CsrfGuard,
    SessionAuthGuard,
    PermissionsGuard,
  ],
})
export class AuthModule {}
