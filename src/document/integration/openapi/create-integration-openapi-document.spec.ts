import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { AccountsController } from 'src/account/accounts.controller';
import { OrganizationApiKeysController } from 'src/api-key/organization-api-keys.controller';
import { AuthController } from 'src/auth/auth.controller';
import { InternalSubscriptionBillingController } from 'src/billing/subscriptions/internal-subscription-billing.controller';
import { applyGlobalApiPrefix } from 'src/common/constants/api-prefix.constants';

import { RFC_FORMAT } from '../../utils/tax-id.util';
import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
  INTEGRATION_DOCUMENTS_TAG,
  INTEGRATION_ORGANIZATION_TAG,
} from '../docs/api-integration-documents-common.docs';
import {
  EXAMPLE_INTEGRATION_ADVANCED_DOCUMENT_PAYLOAD,
  EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD,
} from '../docs/api-integration-examples.docs';
import { IntegrationDocumentsController } from '../integration-documents.controller';
import { IntegrationOrganizationController } from '../integration-organization.controller';
import { IntegrationWebhookEndpointController } from 'src/outbound-webhooks/controllers/integration-webhook-endpoint.controller';
import { INTEGRATION_WEBHOOKS_TAG } from 'src/outbound-webhooks/docs/integration-webhooks-tag.docs';
import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from 'src/outbound-webhooks/enums/outbound-webhook-event-type.enum';
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
        IntegrationOrganizationController,
        IntegrationWebhookEndpointController,
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

  it('contiene exactamente los diez endpoints de integración', () => {
    expect(operationsOf(integration)).toEqual(
      [
        'POST /api/v1/integration/documents',
        'GET /api/v1/integration/documents',
        'GET /api/v1/integration/organization/context',
        'GET /api/v1/integration/webhooks/endpoint',
        'PUT /api/v1/integration/webhooks/endpoint',
        'DELETE /api/v1/integration/webhooks/endpoint',
        'POST /api/v1/integration/webhooks/endpoint/rotate-secret',
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
        expect(operation.tags).toHaveLength(1);
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

  it('publica los tags Integration Documents, Organización y Webhooks, en ese orden y sin otros', () => {
    expect(integration.tags!.map((tag) => tag.name)).toEqual([
      INTEGRATION_DOCUMENTS_TAG,
      INTEGRATION_ORGANIZATION_TAG,
      INTEGRATION_WEBHOOKS_TAG,
    ]);
    for (const tag of integration.tags!) {
      expect(tag.description).toBeTruthy();
    }
  });

  it('agrupa el contexto bajo Organización, la configuración de webhooks bajo Webhooks y el resto bajo documentos', () => {
    for (const operation of operationsOf(integration)) {
      const [method, path] = operation.split(' ');
      const tags =
        integration.paths[path][
          method.toLowerCase() as (typeof HTTP_METHODS)[number]
        ]!.tags;
      const expected =
        path === '/api/v1/integration/organization/context'
          ? INTEGRATION_ORGANIZATION_TAG
          : path.startsWith('/api/v1/integration/webhooks/')
            ? INTEGRATION_WEBHOOKS_TAG
            : INTEGRATION_DOCUMENTS_TAG;
      expect(tags).toEqual([expected]);
    }
  });

  describe('Webhooks', () => {
    const WEBHOOK_ENDPOINT_PATH = '/api/v1/integration/webhooks/endpoint';
    const ROTATE_PATH = `${WEBHOOK_ENDPOINT_PATH}/rotate-secret`;
    const EVENTS = Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM);
    const HEADERS = [
      'X-Signature-Webhook-Id',
      'X-Signature-Event',
      'X-Signature-Timestamp',
      'X-Signature-Hmac',
    ];

    type Schema = {
      $ref?: string;
      properties?: Record<string, Schema>;
      allOf?: Schema[];
      required?: string[];
    };

    const schemaByRef = (ref: string): Schema =>
      (integration.components!.schemas as Record<string, Schema>)[
        ref.replace('#/components/schemas/', '')
      ];

    /** Propiedades de un esquema, siguiendo `$ref` y `allOf` (herencia de clases). */
    const propertiesOf = (schema: Schema): Record<string, Schema> => {
      if (schema.$ref) return propertiesOf(schemaByRef(schema.$ref));
      return Object.assign(
        {},
        ...(schema.allOf ?? []).map(propertiesOf),
        schema.properties ?? {},
      );
    };

    /** Todas las rutas de propiedades de un esquema (`data.document.id`…). */
    const propertyPaths = (schema: Schema, prefix = ''): string[] =>
      Object.entries(propertiesOf(schema)).flatMap(([name, child]) => {
        const path = prefix ? `${prefix}.${name}` : name;
        const nested =
          child.$ref || child.allOf ? propertyPaths(child, path) : [];
        return [path, ...nested];
      });

    /** Las mismas rutas, pero de un ejemplo JSON. */
    const examplePaths = (value: unknown, prefix = ''): string[] =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value).flatMap(([name, child]) => {
            const path = prefix ? `${prefix}.${name}` : name;
            return [path, ...examplePaths(child, path)];
          })
        : [];

    const callbackOf = (event: string) => {
      const put = integration.paths[WEBHOOK_ENDPOINT_PATH].put!;
      const callback = (
        put.callbacks as unknown as Record<
          string,
          Record<string, { post: unknown }>
        >
      )[event];
      return callback['{$request.body#/url}'].post as {
        parameters: {
          name: string;
          in: string;
          required: boolean;
          description: string;
        }[];
        requestBody: {
          content: { 'application/json': { schema: Schema; example: unknown } };
        };
        responses: Record<string, unknown>;
      };
    };

    it('la descripción del tag explica headers, HMAC, reintentos, entrega al menos una vez y deduplicación', () => {
      const description = integration.tags!.find(
        (tag) => tag.name === INTEGRATION_WEBHOOKS_TAG,
      )!.description!;

      for (const text of [
        ...EVENTS,
        ...HEADERS,
        'HMAC-SHA256(secret, timestamp + "." + rawBody)',
        'cuerpo **crudo**',
        'tiempo constante',
        '8 intentos',
        '**Al menos una vez.**',
        'Deduplica por `id`',
        'sólo al crear el endpoint y al rotarlo',
      ]) {
        expect(description).toContain(text);
      }
    });

    it('PUT documenta un callback por evento, con los cuatro headers obligatorios y su payload', () => {
      const put = integration.paths[WEBHOOK_ENDPOINT_PATH].put!;
      expect(Object.keys(put.callbacks ?? {})).toEqual(EVENTS);

      for (const event of EVENTS) {
        const callback = callbackOf(event);
        expect(
          callback.parameters.map((parameter) => [
            parameter.name,
            parameter.in,
            parameter.required,
          ]),
        ).toEqual(HEADERS.map((name) => [name, 'header', true]));
        expect(Object.keys(callback.responses)).toEqual(['2XX', 'default']);

        const body = callback.requestBody.content['application/json'];
        expect(body.schema.$ref).toMatch(/^#\/components\/schemas\//);
        expect(schemaByRef(body.schema.$ref!)).toBeDefined();
        expect((body.example as { type: string }).type).toBe(event);
      }
    });

    it('cada payload documenta exactamente los campos de su ejemplo del contrato', () => {
      for (const event of EVENTS) {
        const body = callbackOf(event).requestBody.content['application/json'];
        expect(propertyPaths(body.schema).sort()).toEqual(
          examplePaths(body.example).sort(),
        );
      }
    });

    it('ningún payload incluye llaves, tokens, PDF, URLs, evidencia, geolocalización ni pagos', () => {
      for (const event of EVENTS) {
        const body = callbackOf(event).requestBody.content['application/json'];
        const names = propertyPaths(body.schema).map(
          (path) => path.split('.').pop()!,
        );
        for (const name of names) {
          expect(name).not.toMatch(
            /key|token|secret|pdf|file|url|certificate|^ip$|geo|location|latitude|longitude|image|evidence|biometric|reason|payment|card|bank|invoice/i,
          );
        }
      }
    });

    it('el secreto sólo viaja al crear (PUT 201) y al rotar; ninguna otra respuesta lo trae', () => {
      const dataOf = (
        path: string,
        method: 'get' | 'put' | 'post' | 'delete',
        status: string,
      ) => {
        const response = integration.paths[path][method]!.responses[
          status
        ] as unknown as {
          content: { 'application/json': { schema: Schema } };
        };
        return propertiesOf(
          propertiesOf(response.content['application/json'].schema).data,
        );
      };

      expect(dataOf(WEBHOOK_ENDPOINT_PATH, 'put', '201')).toHaveProperty(
        'secret',
      );
      expect(dataOf(ROTATE_PATH, 'post', '200')).toHaveProperty('secret');
      for (const [path, method] of [
        [WEBHOOK_ENDPOINT_PATH, 'get'],
        [WEBHOOK_ENDPOINT_PATH, 'put'],
        [WEBHOOK_ENDPOINT_PATH, 'delete'],
      ] as const) {
        const data = dataOf(path, method, '200');
        expect(data).toHaveProperty('secretVersion');
        expect(data).not.toHaveProperty('secret');
      }
    });

    it.each([
      ['get', WEBHOOK_ENDPOINT_PATH, '`WEBHOOK.READ`'],
      ['put', WEBHOOK_ENDPOINT_PATH, '`WEBHOOK.MANAGE`'],
      ['post', ROTATE_PATH, '`WEBHOOK.MANAGE`'],
      ['delete', WEBHOOK_ENDPOINT_PATH, '`WEBHOOK.MANAGE`'],
    ] as const)(
      '%s %s usa X-API-Key y documenta %s',
      (method, path, permission) => {
        const operation = integration.paths[path][method]!;
        expect(operation.security).toEqual([
          { [INTEGRATION_API_KEY_SECURITY]: [] },
        ]);
        expect(operation.description).toContain(permission);
        expect(operation.description).toContain('`X-API-Key`');
      },
    );
  });

  it('GET /integration/organization/context documenta X-API-Key, el permiso y el saldo sin datos de pago', () => {
    const operation =
      integration.paths['/api/v1/integration/organization/context'].get!;

    expect(operation.security).toEqual([
      { [INTEGRATION_API_KEY_SECURITY]: [] },
    ]);
    expect(operation.description).toContain('`X-API-Key`');
    expect(operation.description).toContain(
      '`DOCUMENT.READ` con alcance `ORGANIZATION`',
    );
    expect(operation.parameters ?? []).toEqual([]);

    const schemas = integration.components!.schemas! as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(
      Object.keys(schemas.IntegrationSignatureQuotaData.properties!),
    ).toEqual(
      expect.arrayContaining([
        'planLimit',
        'documentsSigned',
        'documentsRemaining',
        'periodStart',
        'periodEnd',
      ]),
    );
    expect(
      Object.keys(schemas.IntegrationBillingSummaryData.properties!).sort(),
    ).toEqual(
      [
        'billingCycle',
        'nextBillingDate',
        'paymentStatus',
        'plan',
        'status',
      ].sort(),
    );

    const response = JSON.stringify(operation.responses['200']);
    expect(response).not.toMatch(
      /card|last4|iban|clabe|bank|invoice|stripe|customerId|paymentMethod/i,
    );
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

    it('el cuerpo multipart publica los tres ejemplos', () => {
      const body = createOperation().requestBody as {
        content: Record<string, { examples?: Record<string, unknown> }>;
      };

      expect(
        Object.keys(body.content['multipart/form-data'].examples ?? {}),
      ).toEqual(['sequential', 'nonSequential', 'advanced']);
    });
  });

  describe('RFC del firmante avanzado (taxId)', () => {
    const participantSchema = () =>
      integration.components!.schemas!['IntegrationParticipantDto'] as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
    const createOperation = () =>
      integration.paths['/api/v1/integration/documents'].post!;

    it('el participante publica taxId opcional, con su formato y cuándo aplica, y ya no rfc', () => {
      const { properties, required } = participantSchema();

      expect(properties).not.toHaveProperty('rfc');
      expect(required ?? []).not.toContain('taxId');
      expect(properties.taxId).toEqual(
        expect.objectContaining({
          type: 'string',
          minLength: 12,
          maxLength: 13,
          pattern: RFC_FORMAT.source,
          example: 'LOPA800101AB1',
        }),
      );
      expect(properties.taxId.description).toEqual(
        expect.stringMatching(/`role: SIGNER`.*signatureType: ADVANCED/s),
      );
    });

    it('la operación muestra el ejemplo de firma avanzada y los códigos 422 de taxId', () => {
      const operation = createOperation();

      expect(operation.description).toContain(
        JSON.stringify(EXAMPLE_INTEGRATION_ADVANCED_DOCUMENT_PAYLOAD, null, 2),
      );
      expect(operation.description).toContain('"taxId":"MAGL800101AB1"');
      expect(
        (operation.responses['422'] as { description: string }).description,
      ).toEqual(
        expect.stringMatching(
          /INVALID_PARTICIPANT_TAX_ID.*PARTICIPANT_TAX_ID_NOT_ALLOWED.*UNSUPPORTED_PARTICIPANT_FIELD/s,
        ),
      );
    });

    it('ningún ejemplo de payload ni de respuesta exitosa usa rfc', () => {
      const operation = createOperation();
      const requestBody = JSON.stringify(operation.requestBody);
      const successResponses = JSON.stringify([
        operation.responses['200'],
        operation.responses['201'],
      ]);

      expect(requestBody).not.toMatch(/"rfc"/);
      expect(successResponses).not.toMatch(/rfc/i);
      expect(operation.description).not.toMatch(/"rfc"/);
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

  describe('contexto de la organización', () => {
    const schemaOf = (name: string) =>
      integration.components!.schemas![name] as {
        properties: Record<string, unknown>;
      };

    it('no recibe ningún identificador de organización', () => {
      expect(
        integration.paths['/api/v1/integration/organization/context'].get!
          .parameters ?? [],
      ).toEqual([]);
    });

    it('publica el saldo y un resumen de facturación, sin datos sensibles', () => {
      expect(
        Object.keys(schemaOf('IntegrationSignatureQuotaData').properties),
      ).toEqual([
        'planLimit',
        'documentsSigned',
        'documentsRemaining',
        'periodStart',
        'periodEnd',
      ]);
      expect(
        Object.keys(schemaOf('IntegrationBillingSummaryData').properties),
      ).toEqual([
        'plan',
        'status',
        'billingCycle',
        'nextBillingDate',
        'paymentStatus',
      ]);
    });
  });

  it.each([
    [
      'GET',
      '/api/v1/integration/organization/context',
      ['200', '400', '401', '403'],
    ],
    [
      'GET',
      '/api/v1/integration/webhooks/endpoint',
      ['200', '400', '401', '403', '404'],
    ],
    [
      'PUT',
      '/api/v1/integration/webhooks/endpoint',
      ['200', '201', '400', '401', '403', '422', '503'],
    ],
    [
      'POST',
      '/api/v1/integration/webhooks/endpoint/rotate-secret',
      ['200', '400', '401', '403', '404', '503'],
    ],
    [
      'DELETE',
      '/api/v1/integration/webhooks/endpoint',
      ['200', '400', '401', '403', '404'],
    ],
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
