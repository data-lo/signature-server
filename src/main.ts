import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// Módulos privados
import { UserModule } from './user/user.module';
import { DocumentModule } from './document/document.module';
import { SignatureModule } from './signature/signature.module';
import { AuthModule } from './auth/auth.module';
import { DirectoryModule } from './directory/directory.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { IntegrationSettingsModule } from './integration-settings/integration-settings.module';
import { OutboundWebhooksModule } from './outbound-webhooks/outbound-webhooks.module';
import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
} from './document/integration/docs/api-integration-documents-common.docs';
import {
  createIntegrationOpenApiDocument,
  INTEGRATION_OPENAPI_TITLE,
} from './document/integration/openapi/create-integration-openapi-document';
import { MulterExceptionFilter } from './common/filters/multer-exception.filter';
import { applyDiditWebhookBodyParser } from './webhooks/didit/didit-webhook-body-parser';
import { frontendBaseUrl } from './common/utils/frontend-url.util';
import {
  applyGlobalApiPrefix,
  GLOBAL_API_PREFIX,
} from './common/constants/api-prefix.constants';
import { applyRequestContext } from './observability/request-context/request-context.module';
import { REQUEST_ID_HEADER } from './observability/request-context/request-context.constants';

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger(),
    rawBody: true,
  });

  // Primer middleware de Express: abre el contexto de correlación y fija `X-Request-Id` antes que
  // los parsers de body, el ruteo, los middleware de módulo, los guards y los interceptores, para
  // que el header salga también en los 401/403, 422, 429 y 500 que ellos respondan.
  applyRequestContext(app);

  // El versionado vive acá y no dentro de cada `@Controller()`: ver
  // `api-prefix.constants.ts` para el prefijo, las exclusiones y por qué.
  // Tiene que ir ANTES de `SwaggerModule.createDocument`, que lee las rutas ya
  // resueltas — si se llamara después, el Swagger publicaría las rutas sin prefijo.
  applyGlobalApiPrefix(app);
  applyDiditWebhookBodyParser(app);

  // `frontendBaseUrl()` y no `process.env.FRONTEND_URL` crudo: el header `Origin` que manda el
  // navegador nunca lleva diagonal final, así que un `https://app.ejemplo.com/` configurado en el
  // despliegue no casaba con `https://app.ejemplo.com` y el navegador bloqueaba cada petición sin
  // que el servidor registrara ningún error — un fallo mudo y difícil de rastrear desde acá.
  app.enableCors({
    origin: frontendBaseUrl(),
    // Sin esto el navegador oculta `X-Request-Id` al JavaScript del frontend, que lo necesita para
    // que soporte pueda rastrear una petición fallida.
    exposedHeaders: [REQUEST_ID_HEADER],
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
    // API key de organización de la API de integración (`/integration/...`). Mismo header que la
    // llave interna `x-api-key` de arriba, pero es otra cosa: la emite cada organización.
    .addApiKey(
      INTEGRATION_API_KEY_SECURITY_SCHEME,
      INTEGRATION_API_KEY_SECURITY,
    )
    .build();

  const publicDocument = SwaggerModule.createDocument(
    app,
    publicSwaggerConfig,
    {
      include: [
        UserModule,
        DocumentModule,
        SignatureModule,
        AuthModule,
        DirectoryModule,
        ApiKeyModule,
        IntegrationSettingsModule,
        // Configuración del endpoint de webhooks salientes (`/integration/webhooks/endpoint`).
        OutboundWebhooksModule,
      ],
    },
  );

  // `SwaggerModule.setup()` NO recibe el prefijo global —no es una ruta de controlador—, así
  // que el `api/v1` va escrito aquí para que la documentación cuelgue del mismo prefijo que
  // documenta y no quede un `/api/docs` suelto al lado de `/api/v1/...`.
  SwaggerModule.setup(`${GLOBAL_API_PREFIX}/docs`, app, publicDocument);

  // Contrato de los clientes de la API de integración: sólo `/api/v1/integration/...` y sólo
  // `X-API-Key` (ver `createIntegrationOpenApiDocument`). Sale del documento general para que los
  // DTOs y respuestas sean los mismos; Swagger publica además el JSON en `.../integration/docs-json`.
  // Como `/api/v1/docs`, lo sirve el adaptador HTTP y no pasa por los guards: no pide sesión.
  SwaggerModule.setup(
    `${GLOBAL_API_PREFIX}/integration/docs`,
    app,
    createIntegrationOpenApiDocument(publicDocument),
    { customSiteTitle: INTEGRATION_OPENAPI_TITLE },
  );

  await app.listen(process.env.BACKEND_PORT ?? 3000);
  await app.startAllMicroservices();
}
bootstrap();
