import {
  buildIntegrationAccessLogEvent,
  IntegrationAccessLogInput,
  outcomeOf,
} from './integration-access-log.sanitizer';
import { INTEGRATION_ACCESS_OUTCOME_ENUM } from './integration-access-log.interface';

const API_KEY_ID = '0b3f7c2e-9a51-4f0e-8d2c-1e6b5a4c3d2f';
const ORGANIZATION_ID = '7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const DOCUMENT_ID = '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

function input(
  overrides: Partial<IntegrationAccessLogInput> = {},
): IntegrationAccessLogInput {
  return {
    requestId: 'erp-20261114-7f3c2a9d',
    method: 'POST',
    route: '/api/v1/integration/documents',
    statusCode: 201,
    durationMs: 842.4,
    apiKeyId: API_KEY_ID,
    organizationId: ORGANIZATION_ID,
    documentId: DOCUMENT_ID,
    ip: '203.0.113.7',
    errorCode: null,
    ...overrides,
  };
}

describe('buildIntegrationAccessLogEvent', () => {
  it('arma el evento con los campos obligatorios en orden y la duración redondeada', () => {
    const event = buildIntegrationAccessLogEvent(input());
    expect(Object.keys(event)).toEqual([
      'event',
      'requestId',
      'method',
      'route',
      'statusCode',
      'durationMs',
      'outcome',
      'apiKeyId',
      'organizationId',
      'documentId',
      'ip',
      'errorCode',
    ]);
    expect(event).toEqual({
      event: 'integration.http_request',
      requestId: 'erp-20261114-7f3c2a9d',
      method: 'POST',
      route: '/api/v1/integration/documents',
      statusCode: 201,
      durationMs: 842,
      outcome: 'success',
      apiKeyId: API_KEY_ID,
      organizationId: ORGANIZATION_ID,
      documentId: DOCUMENT_ID,
      ip: '203.0.113.7',
      errorCode: null,
    });
  });

  it('los obligatorios desconocidos van en null, nunca se omiten', () => {
    const event = buildIntegrationAccessLogEvent(
      input({
        apiKeyId: undefined,
        organizationId: undefined,
        documentId: undefined,
        ip: undefined,
        errorCode: undefined,
      }),
    );
    expect(event).toEqual(
      expect.objectContaining({
        apiKeyId: null,
        organizationId: null,
        documentId: null,
        ip: null,
        errorCode: null,
      }),
    );
  });

  it('agrega idempotencyReplayed y errorType sólo cuando tienen valor válido', () => {
    expect(
      buildIntegrationAccessLogEvent(input({ idempotencyReplayed: true })),
    ).toHaveProperty('idempotencyReplayed', true);
    expect(buildIntegrationAccessLogEvent(input())).not.toHaveProperty(
      'idempotencyReplayed',
    );
    expect(
      buildIntegrationAccessLogEvent(
        input({ statusCode: 401, errorType: 'InvalidApiKeyException' }),
      ),
    ).toHaveProperty('errorType', 'InvalidApiKeyException');
    // Un éxito no lleva errorType aunque alguien lo haya anotado.
    expect(
      buildIntegrationAccessLogEvent(input({ errorType: 'Error' })),
    ).not.toHaveProperty('errorType');
  });

  it('el cliente que corta queda como 499 client_closed', () => {
    expect(buildIntegrationAccessLogEvent(input({ statusCode: null }))).toEqual(
      expect.objectContaining({ statusCode: 499, outcome: 'client_closed' }),
    );
  });

  describe('descarta lo que no cumple su formato', () => {
    const secret =
      'fma_live_0123456789abcdef_EjemploNoRealEjemploNoRealEjemploNoRea';

    it.each([
      ['apiKeyId con la llave', { apiKeyId: secret }, 'apiKeyId'],
      [
        'organizationId con texto',
        { organizationId: 'Org ERP' },
        'organizationId',
      ],
      [
        'documentId con un correo',
        { documentId: 'ana@correo.test' },
        'documentId',
      ],
      ['ip con un header crudo', { ip: '203.0.113.7, 10.0.0.1' }, 'ip'],
      ['ip UNKNOWN', { ip: 'UNKNOWN' }, 'ip'],
      [
        'errorCode con un mensaje',
        { errorCode: 'API key inválida' },
        'errorCode',
      ],
    ])('%s → null', (_, overrides, field) => {
      const event = buildIntegrationAccessLogEvent(input(overrides));
      expect(event[field as keyof typeof event]).toBeNull();
    });

    it('route con la URL real y query → unmatched', () => {
      expect(
        buildIntegrationAccessLogEvent(
          input({
            route: '/api/v1/integration/users/documents?email=ana@correo.test',
          }),
        ).route,
      ).toBe('unmatched');
    });

    it('requestId con salto de línea → unknown', () => {
      expect(
        buildIntegrationAccessLogEvent(
          input({ requestId: 'a\n{"level":"error"}' }),
        ).requestId,
      ).toBe('unknown');
    });

    it('errorType con espacios, idempotencyReplayed no booleano → se omiten', () => {
      const event = buildIntegrationAccessLogEvent(
        input({
          statusCode: 500,
          errorType: 'Error: fallo ana@correo.test',
          idempotencyReplayed: 'true',
        }),
      );
      expect(event).not.toHaveProperty('errorType');
      expect(event).not.toHaveProperty('idempotencyReplayed');
    });

    it('ningún valor descartado aparece en el evento', () => {
      const json = JSON.stringify(
        buildIntegrationAccessLogEvent(
          input({
            apiKeyId: secret,
            documentId: 'ana@correo.test',
            errorCode: 'Ana Ruiz',
            errorType: 'x y',
          }),
        ),
      );
      expect(json).not.toMatch(/fma_live_|EjemploNoReal|ana@|Ana Ruiz/);
    });
  });
});

describe('outcomeOf', () => {
  it.each([
    [200, INTEGRATION_ACCESS_OUTCOME_ENUM.SUCCESS],
    [304, INTEGRATION_ACCESS_OUTCOME_ENUM.SUCCESS],
    [401, INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_ERROR],
    [429, INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_ERROR],
    [500, INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR],
    [503, INTEGRATION_ACCESS_OUTCOME_ENUM.SERVER_ERROR],
    [null, INTEGRATION_ACCESS_OUTCOME_ENUM.CLIENT_CLOSED],
  ])('%s → %s', (status, outcome) => {
    expect(outcomeOf(status)).toBe(outcome);
  });
});
