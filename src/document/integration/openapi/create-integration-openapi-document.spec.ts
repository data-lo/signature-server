import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { AccountsController } from 'src/account/accounts.controller';
import { OrganizationApiKeysController } from 'src/api-key/organization-api-keys.controller';
import { AuthController } from 'src/auth/auth.controller';
import { InternalSubscriptionBillingController } from 'src/billing/subscriptions/internal-subscription-billing.controller';
import { applyGlobalApiPrefix } from 'src/common/constants/api-prefix.constants';

import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
} from '../docs/api-integration-documents-common.docs';
import {
  EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD,
} from '../docs/api-integration-examples.docs';
import { IntegrationDocumentsController } from '../integration-documents.controller';
import {
  createIntegrationOpenApiDocument,
  findSchemaRefs,
  INTEGRATION_OPENAPI_PATH_PREFIX,
} from './create-integration-openapi-document';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Secretos de entorno ficticios: no deben aparecer en el contrato. */
const ENV_SECRETS = {
  API_KEY: 'secreto-compartido-de-servicios-que-no-debe-publicarse',
  INTERNAL_PLATFORM_API_KEY: 'secreto-interno-de-plataforma-no-publicable',
  INTEGRATION_API_KEY_HMAC_SECRET:
    'secret-hmac-que-no-debe-aparecer-en-el-contrato-publico',
  JWT_SECRET: 'jwt-secreto-que-no-debe-aparecer',
};

/** Las operaciones de un documento como `MÉTODO ruta`, ordenadas. */
function operationsOf(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      HTTP_METHODS.filter((method) => item[method]).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    )
    .sort();
}

describe('createIntegrationOpenApiDocument', () => {
  let app: INestApplication;
  let general: OpenAPIObject;
  let generalSnapshot: string;
  let integration: OpenAPIObject;

  beforeAll(async () => {
    Object.assign(process.env, ENV_SECRETS);

    // La API de integración junto a controllers que NO deben publicarse: administración de llaves
    // (JWT), facturación interna (`@Public()` con `x-api-key`), cuentas y autenticación.
    const moduleRef = await Test.createTestingModule({
      controllers: [
        IntegrationDocumentsController,
        OrganizationApiKeysController,
        InternalSubscriptionBillingController,
        AccountsController,
        AuthController,
      ],
    })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    // Sin `app.init()`, como en `main.ts`: el documento se arma antes de `listen()`.

    // Mismos esquemas de seguridad que el documento general de `main.ts`.
    general = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Signature Server API')
        .setVersion('1.0')
        .addApiKey(
          { type: 'apiKey', name: 'x-api-key', in: 'header' },
          'x-api-key',
        )
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .addApiKey(
          INTEGRATION_API_KEY_SECURITY_SCHEME,
          INTEGRATION_API_KEY_SECURITY,
        )
        .build(),
    );
    generalSnapshot = JSON.stringify(general);
    integration = createIntegrationOpenApiDocument(general);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('el documento general sí tiene rutas ajenas (si no, la prueba no probaría nada)', () => {
    expect(operationsOf(general).length).toBeGreaterThan(5);
    expect(Object.keys(general.components!.securitySchemes!)).toEqual(
      expect.arrayContaining(['access-token', 'x-api-key']),
    );
  });

  it('contiene exactamente los cinco endpoints de integración', () => {
    expect(operationsOf(integration)).toEqual(
      [
        'POST /api/v1/integration/documents',
        'GET /api/v1/integration/documents',
        'GET /api/v1/integration/users/documents',
        'POST /api/v1/integration/documents/{documentId}/signing-access',
        'POST /api/v1/integration/documents/{documentId}/collaborators/resend-invitation',
      ].sort(),
    );
    for (const path of Object.keys(integration.paths)) {
      expect(path.startsWith(INTEGRATION_OPENAPI_PATH_PREFIX)).toBe(true);
    }
  });

  it.each([
    'auth',
    'users/me',
    'organizations',
    'accounts',
    'payments',
    'billing',
    'internal',
  ])('no publica rutas de %s', (segment) => {
    const leaked = Object.keys(integration.paths).filter((path) =>
      path.startsWith(`/api/v1/${segment}`),
    );
    expect(leaked).toEqual([]);
  });

  it('se titula Firmalo Integration API y describe el formato fma_live_*', () => {
    expect(integration.info.title).toBe('Firmalo Integration API');
    expect(integration.info.description).toContain('fma_live_');
    expect(
      integration.components!.securitySchemes![INTEGRATION_API_KEY_SECURITY],
    ).toEqual(
      expect.objectContaining({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: expect.stringContaining('fma_live_<publicId>_<secret>'),
      }),
    );
  });

  it('sólo declara X-API-Key: sin JWT, sin la x-api-key interna', () => {
    expect(Object.keys(integration.components!.securitySchemes!)).toEqual([
      INTEGRATION_API_KEY_SECURITY,
    ]);
    expect(integration.security).toEqual([
      { [INTEGRATION_API_KEY_SECURITY]: [] },
    ]);

    const json = JSON.stringify(integration);
    expect(json).not.toMatch(/bearer/i);
    expect(json).not.toContain('access-token');
    expect(json).not.toContain('"x-api-key"');

    for (const item of Object.values(integration.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (!operation) continue;
        expect(operation.security).toEqual([
          { [INTEGRATION_API_KEY_SECURITY]: [] },
        ]);
        expect(operation.tags).toEqual(['Integration Documents']);
        // La llave se pega una vez en «Authorize»; no se repite como parámetro.
        const headerNames = (operation.parameters ?? []).map((parameter) =>
          'name' in parameter ? parameter.name.toLowerCase() : '',
        );
        expect(headerNames).not.toContain('x-api-key');
        expect(headerNames).not.toContain('authorization');
        // Lo pone el cliente HTTP; Nest lo documentaría como obligatorio por leerlo con @Headers().
        expect(headerNames).not.toContain('user-agent');
        expect(new Set(headerNames).size).toBe(headerNames.length);
      }
    }
  });

  it('POST /integration/documents conserva multipart/form-data y Idempotency-Key', () => {
    const operation = integration.paths['/api/v1/integration/documents'].post!;

    const body = operation.requestBody as {
      content: Record<string, { schema: { $ref: string } }>;
    };
    expect(Object.keys(body.content)).toEqual(['multipart/form-data']);
    const schemaName = body.content['multipart/form-data'].schema.$ref
      .split('/')
      .pop()!;
    const schema = integration.components!.schemas![schemaName] as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.file).toEqual(
      expect.objectContaining({ type: 'string', format: 'binary' }),
    );
    // El JSON del campo `payload` se describe con su estructura, no como texto opaco.
    expect(JSON.stringify(schema.properties.payload)).toContain(
      '#/components/schemas/IntegrationDocumentPayloadDto',
    );

    const headers = (operation.parameters ?? []).filter(
      (parameter) => 'in' in parameter && parameter.in === 'header',
    );
    expect(headers).toEqual([
      expect.objectContaining({
        name: 'Idempotency-Key',
        required: true,
        description: expect.any(String),
        schema: expect.objectContaining({ example: expect.any(String) }),
      }),
    ]);
  });

  describe('dependencias entre isSequential, role y order', () => {
    const schemaProperty = (schemaName: string, property: string) =>
      (
        integration.components!.schemas![schemaName] as {
          properties: Record<string, { description?: string }>;
        }
      ).properties[property];
    const createOperation = () =>
      integration.paths['/api/v1/integration/documents'].post!;

    it('isSequential explica la regla condicional sobre order', () => {
      const { description } = schemaProperty(
        'IntegrationDocumentOptionsDto',
        'isSequential',
      );

      expect(description).toContain('`role: SIGNER` debe incluir `order`');
      expect(description).toContain('se omite');
      expect(description).toContain('`order` no es obligatorio');
    });

    it('order explica formato, inicio, unicidad y consecutividad', () => {
      const order = schemaProperty(
        'IntegrationParticipantDto',
        'order',
      ) as Record<string, unknown>;

      expect(order).toEqual(
        expect.objectContaining({ type: 'integer', minimum: 1 }),
      );
      expect(order.description).toEqual(
        expect.stringMatching(/inicia en 1.*único y consecutivo.*`WITNESS`/s),
      );
    });

    it('la operación muestra el ejemplo secuencial y el no secuencial', () => {
      const description = createOperation().description!;

      expect(description).toContain(
        JSON.stringify(EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD, null, 2),
      );
      expect(description).toContain(
        JSON.stringify(
          EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD,
          null,
          2,
        ),
      );
    });

    it('el cuerpo multipart publica los dos ejemplos', () => {
      const body = createOperation().requestBody as {
        content: Record<string, { examples?: Record<string, unknown> }>;
      };

      expect(
        Object.keys(body.content['multipart/form-data'].examples ?? {}),
      ).toEqual(['sequential', 'nonSequential']);
    });
  });

  describe('identificación por correo', () => {
    it('el listado por usuario exige email en el query y no publica userId', () => {
      const { parameters } = integration.paths[
        '/api/v1/integration/users/documents'
      ].get as unknown as { parameters: Record<string, unknown>[] };
      const names = parameters.map(({ name }) => name);

      expect(names).not.toContain('userId');
      expect(parameters.find(({ name }) => name === 'email')).toEqual(
        expect.objectContaining({ in: 'query', required: true }),
      );
    });

    it('el reenvío recibe email en el cuerpo y no publica collaboratorId', () => {
      const path =
        '/api/v1/integration/documents/{documentId}/collaborators/resend-invitation';
      const operation = integration.paths[path].post as {
        parameters: { name: string }[];
        requestBody: Record<string, any>;
      };
      const schemaRef = operation.requestBody.content['application/json'].schema
        .$ref as string;
      const schema = integration.components!.schemas![
        schemaRef.split('/').pop()!
      ] as { properties: Record<string, unknown>; required: string[] };

      expect(operation.parameters.map(({ name }) => name)).toEqual([
        'documentId',
      ]);
      expect(schema.required).toEqual(['email']);
      expect(Object.keys(schema.properties)).toEqual(['email']);
    });

    it('ninguna respuesta exitosa publica ids internos de usuario o colaborador', () => {
      const data = integration.components!.schemas![
        'IntegrationResentInvitationData'
      ] as { properties: Record<string, unknown> };

      expect(Object.keys(data.properties)).toContain('email');
      expect(data.properties).not.toHaveProperty('collaboratorId');
      for (const path of Object.keys(integration.paths)) {
        expect(path).not.toMatch(/\{(userId|collaboratorId)\}/);
      }
    });
  });

  it.each([
    [
      'POST',
      '/api/v1/integration/documents',
      ['200', '201', '400', '401', '402', '403', '409', '422'],
    ],
    [
      'GET',
      '/api/v1/integration/documents',
      ['200', '400', '401', '403', '404', '409', '422'],
    ],
    [
      'GET',
      '/api/v1/integration/users/documents',
      ['200', '400', '401', '403', '404', '409', '422'],
    ],
    [
      'POST',
      '/api/v1/integration/documents/{documentId}/signing-access',
      ['200', '400', '401', '403', '404', '409', '422', '429'],
    ],
    [
      'POST',
      '/api/v1/integration/documents/{documentId}/collaborators/resend-invitation',
      ['200', '400', '401', '403', '404', '409', '422', '429'],
    ],
  ])(
    '%s %s documenta sus respuestas con ejemplos',
    (method, path, statuses) => {
      const operation =
        integration.paths[path][method.toLowerCase() as 'get' | 'post']!;
      expect(Object.keys(operation.responses).sort()).toEqual(
        [...statuses].sort(),
      );

      for (const status of statuses.filter((code) => code.startsWith('4'))) {
        const content = (
          operation.responses[status] as {
            content: Record<string, { examples?: Record<string, unknown> }>;
          }
        ).content['application/json'];
        expect(Object.keys(content.examples ?? {}).length).toBeGreaterThan(0);
      }
    },
  );

  it('conserva las respuestas y DTOs de integración, y nada de los controllers ajenos', () => {
    const schemas = Object.keys(integration.components!.schemas!);
    expect(schemas).toEqual(
      expect.arrayContaining([
        'CreateIntegrationDocumentDto',
        'IntegrationDocumentPayloadDto',
        'IntegrationCreatedDocumentResponse',
        'IntegrationDocumentsPageResponse',
        'IntegrationSigningAccessResponse',
        'IntegrationResentInvitationResponse',
        'IntegrationErrorResponseDto',
        'CreateIntegrationSigningAccessDto',
      ]),
    );
    for (const foreign of [
      'CreateOrganizationApiKeyDto',
      'RotateOrganizationApiKeyDto',
      'RegisterManualSubscriptionBillingDto',
    ]) {
      expect(schemas).not.toContain(foreign);
      expect(general.components!.schemas).toHaveProperty(foreign);
    }
  });

  it('es OpenAPI válido: versión, info, operaciones con respuestas y todo $ref resuelto', () => {
    const roundTrip = JSON.parse(JSON.stringify(integration));
    expect(roundTrip).toEqual(integration);
    expect(integration.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(integration.info.version).toEqual(expect.any(String));

    const schemas = integration.components!.schemas!;
    for (const name of findSchemaRefs(integration)) {
      expect(schemas).toHaveProperty(name);
    }
    for (const item of Object.values(integration.paths)) {
      for (const method of HTTP_METHODS) {
        if (item[method]) {
          expect(Object.keys(item[method]!.responses).length).toBeGreaterThan(
            0,
          );
        }
      }
    }
  });

  it('no publica secretos ni valores de entorno; la llave de ejemplo es ficticia', () => {
    const json = JSON.stringify(integration);
    for (const secret of Object.values(ENV_SECRETS)) {
      expect(json).not.toContain(secret);
    }
    for (const name of [
      'INTERNAL_PLATFORM_API_KEY',
      'INTEGRATION_API_KEY_HMAC_SECRET',
      'JWT_SECRET',
    ]) {
      expect(json).not.toContain(name);
    }
    const keys = json.match(/fma_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/g) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain('EjemploNoReal');
    }
  });

  it('no modifica el documento general', () => {
    expect(JSON.stringify(general)).toBe(generalSnapshot);
  });

  it('descarta los esquemas que sólo usaban rutas ajenas, aunque se referencien entre sí', () => {
    const result = createIntegrationOpenApiDocument({
      openapi: '3.0.0',
      info: { title: 'x', version: '1.0' },
      paths: {
        '/api/v1/integration/documents': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Page' },
                  },
                },
              },
            },
          },
        },
        '/api/v1/integrations-admin': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Admin' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Page: {
            type: 'object',
            properties: { items: { $ref: '#/components/schemas/Item' } },
          },
          Item: { type: 'object' },
          Admin: {
            type: 'object',
            properties: { item: { $ref: '#/components/schemas/Item' } },
          },
        },
      },
    });

    expect(Object.keys(result.paths)).toEqual([
      '/api/v1/integration/documents',
    ]);
    expect(Object.keys(result.components!.schemas!)).toEqual(['Item', 'Page']);
  });
});
