import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger(),
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Signature Server API')
    .setDescription('API para gestión de firmas digitales y documentos')
    .setVersion('1.0')
        .addApiKey(
      { type: 'apiKey', name: 'API_KEY', in: 'header' },
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  app.useGlobalFilters();
  app.useGlobalInterceptors();
  await app.listen(3000);
}
bootstrap();
