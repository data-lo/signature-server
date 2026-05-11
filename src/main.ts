import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

// Módulos públicos
import { VerificationCodeModule } from './verification-code/verification-code.module';

// Módulos privados
import { UserModule } from './user/user.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger(),
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
    .build();

  const publicDocument = SwaggerModule.createDocument(app, publicSwaggerConfig, {
    include: [UserModule, DocumentModule, SignatureModule],
  });

  SwaggerModule.setup('api/docs', app, publicDocument);

  // Swagger Privado
  const privateSwaggerConfig = new DocumentBuilder()
    .setTitle('Signature Server API - Intern')
    .setDescription('Endpoints Internos')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const privateDocument = SwaggerModule.createDocument(app, privateSwaggerConfig, {
    include: [VerificationCodeModule],
  });
  SwaggerModule.setup('api/internal/docs', app, privateDocument);

  app.useGlobalFilters();
  app.useGlobalInterceptors();
  await app.listen(3000);
}
bootstrap();