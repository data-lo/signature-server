import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

// Módulos privados
import { UserModule } from './user/user.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { AuthModule } from './auth/auth.module';
import { MulterExceptionFilter } from './shared/filters/multer-exception.filter';
import { frontendBaseUrl } from './shared/utils/frontend-url.util';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger(),
    rawBody: true,
  });

  // `frontendBaseUrl()` y no `process.env.FRONTEND_URL` crudo: el header `Origin` que manda el
  // navegador nunca lleva diagonal final, así que un `https://app.ejemplo.com/` configurado en el
  // despliegue no casaba con `https://app.ejemplo.com` y el navegador bloqueaba cada petición sin
  // que el servidor registrara ningún error — un fallo mudo y difícil de rastrear desde acá.
  app.enableCors({
    origin: frontendBaseUrl(),
  });

  // Conexión del Microservicio Kafka (Consumer)
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env.KAFKA_CLIENT_ID ?? 'signature-server',
        brokers: [process.env.KAFKA_BROKER ?? 'localhost:9094'],
      },
      consumer: {
        groupId:
          process.env.KAFKA_CONSUMER_GROUP_ID ?? 'signature-server-consumer',
      },
    },
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new MulterExceptionFilter(httpAdapter));

  // Swagger Público
  const publicSwaggerConfig = new DocumentBuilder()
    .setTitle('Signature Server API')
    .setDescription('API para gestión de firmas digitales y documentos')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'x-api-key')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();

  const publicDocument = SwaggerModule.createDocument(
    app,
    publicSwaggerConfig,
    {
      include: [UserModule, DocumentModule, SignatureModule, AuthModule],
    },
  );

  SwaggerModule.setup('api/docs', app, publicDocument);

  await app.listen(3000);
  await app.startAllMicroservices();
}
bootstrap();
