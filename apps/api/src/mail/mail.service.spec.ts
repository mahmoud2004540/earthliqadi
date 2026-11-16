import { MailService } from './mail.service';
import type { AppConfig } from '../config/app-config';

const sendMail = jest.fn();
const close = jest.fn();
const createTransport = jest.fn((..._args: unknown[]) => ({ sendMail, close }));
jest.mock('nodemailer', () => ({ createTransport: (...a: unknown[]) => createTransport(...a) }));

const smtpConfig = {
  MAIL_TRANSPORT: 'smtp',
  MAIL_FROM: 'Exchange <no-reply@exchange.invalid>',
  SMTP_HOST: 'smtp.invalid',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'user',
  SMTP_PASSWORD: 'secret',
} as unknown as AppConfig;

const message = {
  to: 'a@b.invalid',
  subject: 'Verify',
  text: 'link',
  kind: 'email_verification' as const,
};

describe('MailService (smtp)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delivers over SMTP and requires TLS on a STARTTLS port', async () => {
    const mail = new MailService(smtpConfig);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.invalid',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'user', pass: 'secret' },
      }),
    );
    sendMail.mockResolvedValueOnce({});
    await mail.send(message);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Exchange <no-reply@exchange.invalid>',
      to: 'a@b.invalid',
      subject: 'Verify',
      text: 'link',
    });
    expect(mail.sentMessages()).toHaveLength(0);
    mail.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('never reports a failed delivery as sent', async () => {
    const mail = new MailService(smtpConfig);
    sendMail.mockRejectedValueOnce(new Error('connection refused'));
    await expect(mail.send(message)).rejects.toThrow('connection refused');
  });

  it('does not open SMTP for the development transports', async () => {
    const mail = new MailService({ MAIL_TRANSPORT: 'memory' } as unknown as AppConfig);
    await mail.send(message);
    expect(createTransport).not.toHaveBeenCalled();
    expect(mail.sentMessages()).toEqual([message]);
  });
});
