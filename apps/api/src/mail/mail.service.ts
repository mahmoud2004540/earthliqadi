import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Message category; lets tests and the dev log find specific mails. */
  kind: 'email_verification' | 'password_reset' | 'security_notice';
}

/**
 * Development-only mail transports:
 *  - `log`:    writes the message (including links) to the server log. Local use only.
 *  - `memory`: keeps messages in memory for automated tests.
 *
 * There is NO production transport yet. Environment validation refuses to
 * start staging/production with these transports, so security emails can never
 * be silently dropped or logged in a real deployment.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');
  private readonly outbox: MailMessage[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: MailMessage): Promise<void> {
    if (this.config.MAIL_TRANSPORT === 'memory') {
      this.outbox.push(message);
      return;
    }
    this.logger.warn(
      `[DEV MAIL — not delivered] to=${message.to} kind=${message.kind} subject="${message.subject}"\n${message.text}`,
    );
    await Promise.resolve();
  }

  /** Test helper: messages captured by the `memory` transport. */
  sentMessages(): readonly MailMessage[] {
    return this.outbox;
  }
}
