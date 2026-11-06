import { Module } from '@nestjs/common';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { PasswordService } from '../security/password.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfService } from './csrf.service';
import { CsrfGuard, PermissionsGuard, SessionAuthGuard } from './guards';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController, ApiKeysController],
  providers: [
    AuthService,
    SessionService,
    CsrfService,
    MfaService,
    PasswordService,
    ApiKeysService,
    CsrfGuard,
    SessionAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    AuthService,
    ApiKeysService,
    SessionService,
    CsrfService,
    MfaService,
    CsrfGuard,
    SessionAuthGuard,
    PermissionsGuard,
  ],
})
export class AuthModule {}
