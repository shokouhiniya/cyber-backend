import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Increase body size limit for batch import (profile contexts can be large)
  app.use(require('express').json({ limit: '10mb' }));
  app.use(require('express').urlencoded({ limit: '10mb', extended: true }));

  app.enableCors({
    origin: ['http://localhost:3033', 'http://localhost:3000', 'https://cyber.mardomi.org', 'https://cyber.pish.run'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // Serve static files from /static
  app.useStaticAssets(join(__dirname, '..', 'static'), { prefix: '/static/' });

  // Serve documentation files (user guides + spec docs)
  app.useStaticAssets(join(__dirname, '..', 'docs'), { prefix: '/docs/' });

  app.setGlobalPrefix('api');

  const port = process.env.PORT ?? 3000;
  const host = process.env.HOST ?? 'localhost';
  await app.listen(port, host);
  console.log(`🚀 Server running on http://${host}:${port}`);
}

bootstrap();
