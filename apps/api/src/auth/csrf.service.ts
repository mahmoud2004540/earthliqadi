import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { hmacBase64Url, randomToken, safeEqual } from '../security/crypto';

/**
 * Signed double-submit CSRF tokens: `<nonce>.<hmac(nonce)>`.
 * The token is returned in the response body and also set as an httpOnly,
 * SameSite=Strict cookie. State-changing requests must echo the token in the
 * `X-CSRF-Token` header; the guard checks header == cookie and the signature.
 */
@Injectable()
export class CsrfService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  issue(): string {
    const nonce = randomToken(24);
    return `${nonce}.${hmacBase64Url(this.config.CSRF_SECRET, nonce)}`;
  }

  isValid(headerToken: string | undefined, cookieToken: string | undefined): boolean {
    if (!headerToken || !cookieToken || headerToken.length > 256) return false;
    if (!safeEqual(headerToken, cookieToken)) return false;
    const [nonce, signature, ...rest] = headerToken.split('.');
    if (!nonce || !signature || rest.length > 0) return false;
    return safeEqual(signature, hmacBase64Url(this.config.CSRF_SECRET, nonce));
  }
}
