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
import {
  applyGlobalApiPrefix,
  GLOBAL_API_PREFIX,
} from './shared/constants/api-prefix.constants';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger(),
    rawBody: true,
  });

  // El versionado vive acá y no dentro de cada `@Controller()`: ver
  // `api-prefix.constants.ts` para el prefijo, las exclusiones y por qué.
  // Tiene que ir ANTES de `SwaggerModule.createDocument`, que lee las rutas ya
  // resueltas — si se llamara después, el Swagger publicaría las rutas sin prefijo.
  applyGlobalApiPrefix(app);

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

  // `SwaggerModule.setup()` NO recibe el prefijo global —no es una ruta de controlador—, así
  // que el `api/v1` va escrito aquí para que la documentación cuelgue del mismo prefijo que
  // documenta y no quede un `/api/docs` suelto al lado de `/api/v1/...`.
  SwaggerModule.setup(`${GLOBAL_API_PREFIX}/docs`, app, publicDocument);

  await app.listen(process.env.BACKEND_PORT ?? 3000);
  await app.startAllMicroservices();
}
bootstrap();
