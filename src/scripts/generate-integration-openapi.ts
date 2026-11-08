import { writeFileSync } from 'fs';
import { resolve } from 'path';

import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { dump } from 'js-yaml';

import { AppModule } from '../app.module';
import { applyGlobalApiPrefix } from '../common/constants/api-prefix.constants';
import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
} from '../document/integration/docs/api-integration-documents-common.docs';
import { createIntegrationOpenApiDocument } from '../document/integration/openapi/create-integration-openapi-document';

/** Archivo que publica Mintlify, relativo a la raíz del repo. */
const OUTPUT_PATH = resolve(process.cwd(), 'docs', 'openapi.yaml');

/** Host reservado: deja claro que falta definir `INTEGRATION_API_PUBLIC_URL`. */
const PLACEHOLDER_PUBLIC_URL = 'https://api.firmalo.example';

/**
 * Escribe `docs/openapi.yaml` con el mismo contrato que publica `/api/v1/integration/docs`.
 *
 * Usa el modo `preview` de Nest, que recorre módulos y controladores sin instanciar proveedores:
 * no abre conexiones ni necesita Postgres, Kafka, Redis o MinIO. Sólo agrega `servers`, que
 * Mintlify necesita y Swagger UI no, y que sale de `INTEGRATION_API_PUBLIC_URL`.
 *
 * @returns Nada; deja el archivo escrito.
 *
 * @throws {Error} Si la aplicación no se puede recorrer o el archivo no se puede escribir.
 *
 * @example
 * ```bash
 * INTEGRATION_API_PUBLIC_URL=https://api.ejemplo.com npm run docs:openapi
 * ```
 */
async function generateIntegrationOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    abortOnError: false,
    logger: false,
  });
  applyGlobalApiPrefix(app);

  const document = createIntegrationOpenApiDocument(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addApiKey(
          INTEGRATION_API_KEY_SECURITY_SCHEME,
          INTEGRATION_API_KEY_SECURITY,
        )
        .build(),
    ),
  );
  document.servers = [
    { url: process.env.INTEGRATION_API_PUBLIC_URL ?? PLACEHOLDER_PUBLIC_URL },
  ];

  writeFileSync(OUTPUT_PATH, dump(document, { noRefs: true, lineWidth: -1 }));
  await app.close();

  console.log(
    `${OUTPUT_PATH}: ${Object.keys(document.paths).length} rutas publicadas.`,
  );
}

generateIntegrationOpenApi()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
