import { VersioningType, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import type { AppConfig } from './config/app-config';

/**
 * Builds the fully configured application. Shared by `main.ts` and the
 * integration tests so tests exercise the real middleware stack.
 */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: config.SWAGGER_ENABLED
        ? undefined // helmet defaults (self-only) so Swagger UI can load
        : { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.useBodyParser('json', { limit: '64kb' });
  app.use(cookieParser());
  // CORS is deliberately not enabled: the web app reaches the API through a
  // same-origin reverse proxy, so browsers must not be allowed cross-origin reads.

  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalFilters(new HttpExceptionFilter());

  // Body-parser errors are raised before Nest's router; normalise them here so
  // Express never renders its default (stack-trace-bearing) error page.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    const status =
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const safeStatus = status >= 400 && status < 500 ? status : 500;
    res.status(safeStatus).json({
      error: {
        code: safeStatus === 413 || safeStatus === 400 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
        message:
          safeStatus === 413
            ? 'Request body too large'
            : safeStatus < 500
              ? 'Malformed request'
              : 'An unexpected error occurred',
        requestId: typeof req.id === 'string' ? req.id : undefined,
      },
    });
  });

  if (config.SWAGGER_ENABLED) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Exchange Platform API')
        .setDescription('Pre-launch development API. Not for production use.')
        .setVersion('0.1.0')
        .addCookieAuth(config.SESSION_COOKIE_SECURE ? '__Host-session' : 'session')
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }

  app.enableShutdownHooks();
  return app;
}
