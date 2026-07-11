import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

// Módulos privados
import { UserModule } from './user/user.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { AuthModule } from './auth/auth.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger(),
  });

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3001',
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // Swagger Público
  const publicSwaggerConfig = new DocumentBuilder()
    .setTitle('Signature Server API')
    .setDescription('API para gestión de firmas digitales y documentos')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'x-api-key')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .build();

  const publicDocument = SwaggerModule.createDocument(app, publicSwaggerConfig, {
    include: [UserModule, DocumentModule, SignatureModule, AuthModule],
  });

  SwaggerModule.setup('api/docs', app, publicDocument);

  app.useGlobalFilters();
  app.useGlobalInterceptors();
  await app.listen(3000);
}
bootstrap();