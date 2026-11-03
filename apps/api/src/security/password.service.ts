import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/** Argon2id password hashing (OWASP parameters, configurable upwards only). */
@Injectable()
export class PasswordService {
  private readonly options: argon2.HashOptions;
  private dummyHash: Promise<string> | null = null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: config.ARGON2_MEMORY_KIB,
      timeCost: config.ARGON2_TIME_COST,
      parallelism: config.ARGON2_PARALLELISM,
    };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Burn equivalent CPU when the account does not exist, so response timing
   * does not reveal whether an email is registered.
   */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, password);
  }

  needsRehash(hash: string): boolean {
    const { timeCost, memoryCost, parallelism } = this.options;
    return argon2.needsRehash(hash, { timeCost, memoryCost, parallelism });
  }
}
