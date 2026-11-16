import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Message category; lets tests and the dev log find specific mails. */
  kind: 'email_verification' | 'password_reset' | 'security_notice';
}

/**
 * Mail transports:
 *  - `smtp`:   real delivery over SMTP with TLS (implicit, or STARTTLS which is
 *              then required). The only transport allowed outside local/ci.
 *  - `log`:    writes the message (including links) to the server log. Local use only.
 *  - `memory`: keeps messages in memory for automated tests.
 *
 * A failed SMTP send throws: callers decide whether the request fails, and
 * a security e-mail is never reported as sent when it was not.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger('MailService');
  private readonly outbox: MailMessage[] = [];
  private readonly smtp: Transporter | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.smtp =
      config.MAIL_TRANSPORT === 'smtp'
        ? createTransport({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_SECURE,
            requireTLS: !config.SMTP_SECURE,
            auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
          })
        : null;
  }

  async send(message: MailMessage): Promise<void> {
    if (this.smtp) {
      await this.smtp.sendMail({
        from: this.config.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      // Never log the body: it can contain one-time links.
      this.logger.log(`mail sent kind=${message.kind}`);
      return;
    }
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

  onModuleDestroy(): void {
    this.smtp?.close();
  }
}
