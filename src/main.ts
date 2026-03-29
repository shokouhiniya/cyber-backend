import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: ['http://localhost:3033', 'http://localhost:3000', 'https://cyber.mardomi.org'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  app.setGlobalPrefix('api');

  const port = process.env.PORT ?? 3000;
  const host = process.env.HOST ?? 'localhost';
  await app.listen(port, host);
  console.log(`🚀 Server running on http://${host}:${port}`);
}

bootstrap();
