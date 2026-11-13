import { randomUUID } from 'crypto';
import { FindOperator, QueryFailedError } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { WebhookEndpointEntity } from '../entities/webhook-endpoint.entity';
import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM as EVENT } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_ENDPOINT_STATUS_ENUM } from '../enums/webhook-endpoint-status.enum';
import { WEBHOOK_SUBJECT_TYPE_ENUM } from '../enums/webhook-subject-type.enum';
import {
  WebhookEndpointNotFoundException,
  WebhookSecretEncryptionUnavailableException,
} from '../exceptions/outbound-webhook.exceptions';
import { DisableWebhookEndpointUseCase } from './disable-webhook-endpoint.use-case';
import { GetWebhookEndpointUseCase } from './get-webhook-endpoint.use-case';
import { RotateWebhookSecretUseCase } from './rotate-webhook-secret.use-case';
import { UpsertWebhookEndpointUseCase } from './upsert-webhook-endpoint.use-case';

const API_CLIENT: IntegrationApiClient = {
  apiKeyId: 'key-1',
  apiKeyName: 'ERP',
  organizationId: 'org-1',
  actorAccountId: null,
  actorUserId: null,
  permissions: [],
};

const OTHER_ORGANIZATION: IntegrationApiClient = {
  ...API_CLIENT,
  apiKeyId: 'key-2',
  organizationId: 'org-2',
};

type Row = Record<string, unknown>;

/** Repositorio en memoria con lo que usan los casos de uso: `findOne`, `create` y `save`. */
function inMemoryRepository(
  rows: Row[],
  onInsert: (row: Row) => void = () => undefined,
) {
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof FindOperator && value.type === 'isNull'
        ? row[key] === null || row[key] === undefined
        : row[key] === value,
    );

  return {
    rows,
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      const found = rows.find((row) => matches(row, where));
      return found ? { ...found } : null;
    }),
    create: jest.fn((data: Row) => ({ ...data })),
    save: jest.fn(async (entity: Row) => {
      const now = new Date();
      const existing = rows.find((row) => row.id && row.id === entity.id);
      if (existing) {
        Object.assign(existing, entity, { updatedAt: now });
        return { ...existing };
      }
      const created = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...entity,
      };
      onInsert(created);
      rows.push(created);
      return { ...created };
    }),
  };
}

describe('casos de uso del endpoint de webhooks', () => {
  let endpoints: Row[];
  let versions: Row[];
  let endpointRepository: ReturnType<typeof inMemoryRepository>;
  let versionRepository: ReturnType<typeof inMemoryRepository>;
  let dataSource: {
    manager: { getRepository: jest.Mock };
    transaction: jest.Mock;
  };
  let urlPolicy: { assertAllowed: jest.Mock };
  let cipher: {
    generateSecret: jest.Mock;
    encrypt: jest.Mock;
  };
  let secretCounter: number;

  const upsert = () =>
    new UpsertWebhookEndpointUseCase(
      dataSource as never,
      urlPolicy as never,
      cipher as never,
    );
  const get = () => new GetWebhookEndpointUseCase(dataSource as never);
  const rotate = () =>
    new RotateWebhookSecretUseCase(dataSource as never, cipher as never);
  const disable = () => new DisableWebhookEndpointUseCase(dataSource as never);

  const createEndpoint = () =>
    upsert().execute(API_CLIENT, {
      url: 'https://erp.cliente.com/hook',
      events: [EVENT.DOCUMENT_SIGNED, EVENT.DOCUMENT_COLLABORATOR_SIGNED],
    });

  beforeEach(() => {
    endpoints = [];
    versions = [];
    endpointRepository = inMemoryRepository(endpoints);
    versionRepository = inMemoryRepository(versions, (row) => {
      // Lo que garantiza `UQ_webhook_secret_versions_active` en la base.
      const otherActive = versions.some(
        (version) =>
          version.endpointId === row.endpointId && version.retiredAt === null,
      );
      if (row.retiredAt === null && otherActive) {
        throw new Error('UQ_webhook_secret_versions_active');
      }
    });
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === WebhookEndpointEntity
          ? endpointRepository
          : versionRepository,
      ),
    };
    dataSource = {
      manager,
      transaction: jest.fn(async (work: (m: typeof manager) => unknown) =>
        work(manager),
      ),
    };
    urlPolicy = {
      assertAllowed: jest.fn(async (url: string) => url.toLowerCase()),
    };
    secretCounter = 0;
    cipher = {
      generateSecret: jest.fn(() => `whsec_secreto_${++secretCounter}`),
      encrypt: jest.fn((secret: string) => `cifrado(${secret})`),
    };
  });

  describe('UpsertWebhookEndpointUseCase', () => {
    it('crea el endpoint activo con la versión 1 cifrada y devuelve el secreto una vez', async () => {
      const result = await createEndpoint();

      expect(result.created).toBe(true);
      expect(result.response.data).toEqual(
        expect.objectContaining({
          url: 'https://erp.cliente.com/hook',
          status: WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE,
          events: [EVENT.DOCUMENT_COLLABORATOR_SIGNED, EVENT.DOCUMENT_SIGNED],
          secretVersion: 1,
          disabledAt: null,
          secret: 'whsec_secreto_1',
        }),
      );
      expect(endpoints[0]).toEqual(
        expect.objectContaining({
          subjectType: WEBHOOK_SUBJECT_TYPE_ENUM.ORGANIZATION,
          subjectId: 'org-1',
        }),
      );
      expect(versions).toEqual([
        expect.objectContaining({
          endpointId: endpoints[0].id,
          version: 1,
          encryptedSecret: 'cifrado(whsec_secreto_1)',
          retiredAt: null,
        }),
      ]);
      expect(JSON.stringify(versions)).not.toContain('"whsec_secreto_1"');
    });

    it('actualiza URL y eventos sin tocar ni devolver el secreto, y reactiva uno desactivado', async () => {
      await createEndpoint();
      await disable().execute(API_CLIENT);

      const result = await upsert().execute(API_CLIENT, {
        url: 'https://nuevo.cliente.com/hook',
        events: [EVENT.DOCUMENT_CANCELLED],
      });

      expect(result.created).toBe(false);
      expect(result.response.data).toEqual(
        expect.objectContaining({
          url: 'https://nuevo.cliente.com/hook',
          status: WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE,
          events: [EVENT.DOCUMENT_CANCELLED],
          secretVersion: 1,
          disabledAt: null,
        }),
      );
      expect(result.response.data).not.toHaveProperty('secret');
      expect(versions).toHaveLength(1);
      expect(cipher.generateSecret).toHaveBeenCalledTimes(1);
    });

    it('valida la URL antes de abrir la transacción', async () => {
      urlPolicy.assertAllowed.mockRejectedValue(new Error('URL no permitida'));

      await expect(createEndpoint()).rejects.toThrow('URL no permitida');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('sin llave de cifrado no guarda nada', async () => {
      cipher.encrypt.mockImplementation(() => {
        throw new WebhookSecretEncryptionUnavailableException();
      });

      await expect(createEndpoint()).rejects.toThrow(
        WebhookSecretEncryptionUnavailableException,
      );
      expect(endpoints).toEqual([]);
    });

    it('si otra petición creó el endpoint a la vez, reintenta y lo actualiza', async () => {
      const race = new QueryFailedError('INSERT', [], {
        code: '23505',
      } as never);
      dataSource.transaction.mockImplementationOnce(async () => {
        await createEndpoint();
        throw race;
      });

      const result = await upsert().execute(API_CLIENT, {
        url: 'https://erp.cliente.com/otra',
        events: [EVENT.DOCUMENT_REJECTED],
      });

      expect(result.created).toBe(false);
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].url).toBe('https://erp.cliente.com/otra');
    });
  });

  describe('GetWebhookEndpointUseCase', () => {
    it('devuelve la configuración sin secreto ni texto cifrado', async () => {
      await createEndpoint();

      const { data } = await get().execute(API_CLIENT);

      expect(data).toEqual(
        expect.objectContaining({ secretVersion: 1, status: 'ACTIVE' }),
      );
      expect(JSON.stringify(data)).not.toMatch(/whsec_|cifrado/);
    });

    it('responde 404 sin endpoint y no ve el de otra organización', async () => {
      await createEndpoint();

      await expect(get().execute(OTHER_ORGANIZATION)).rejects.toThrow(
        WebhookEndpointNotFoundException,
      );
    });
  });

  describe('RotateWebhookSecretUseCase', () => {
    it('retira la versión activa, crea la siguiente y devuelve el secreto nuevo', async () => {
      await createEndpoint();

      const { data } = await rotate().execute(API_CLIENT);

      expect(data).toEqual(
        expect.objectContaining({
          secretVersion: 2,
          secret: 'whsec_secreto_2',
        }),
      );
      expect(versions).toEqual([
        expect.objectContaining({ version: 1, retiredAt: expect.any(Date) }),
        expect.objectContaining({
          version: 2,
          retiredAt: null,
          encryptedSecret: 'cifrado(whsec_secreto_2)',
        }),
      ]);
      await expect(get().execute(API_CLIENT)).resolves.toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ secretVersion: 2 }),
        }),
      );
    });

    it('responde 404 sin endpoint', async () => {
      await expect(rotate().execute(API_CLIENT)).rejects.toThrow(
        WebhookEndpointNotFoundException,
      );
    });
  });

  describe('DisableWebhookEndpointUseCase', () => {
    it('lo pasa a DISABLED con fecha y es idempotente', async () => {
      await createEndpoint();

      const first = await disable().execute(API_CLIENT);
      const second = await disable().execute(API_CLIENT);

      expect(first.data).toEqual(
        expect.objectContaining({
          status: WEBHOOK_ENDPOINT_STATUS_ENUM.DISABLED,
          disabledAt: expect.any(String),
        }),
      );
      expect(second.data!.disabledAt).toBe(first.data!.disabledAt);
      expect(versions).toHaveLength(1);
    });

    it('responde 404 sin endpoint', async () => {
      await expect(disable().execute(API_CLIENT)).rejects.toThrow(
        WebhookEndpointNotFoundException,
      );
    });
  });
});
