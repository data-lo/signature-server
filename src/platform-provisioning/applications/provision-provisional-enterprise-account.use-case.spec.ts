import {
  API_KEY_ASSIGNABLE_PERMISSION_KEYS,
  API_KEY_FORBIDDEN_RESOURCES,
} from 'src/api-key/api-key-permission-policy';
import { ApiKeyEntity } from 'src/api-key/entities/api-key.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { UserEntity } from 'src/user/entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import { DEFAULT_INTEGRATION_PERMISSION_KEYS } from '../constants/default-integration-permissions';
import { PlatformProvisioningRequestEntity } from '../entities/platform-provisioning-request.entity';
import {
  ConcurrentProvisioningException,
  ProvisionalOwnerEmailAlreadyRegisteredException,
  ProvisioningExternalReferenceAlreadyUsedException,
  ProvisioningIdempotencyKeyMismatchException,
  ProvisioningInvalidBillingPeriodException,
} from '../exceptions/platform-provisioning.exceptions';
import {
  buildProvisioningRequestHash,
  PROVISIONING_ADVISORY_LOCK_NAMESPACE,
  ProvisionProvisionalEnterpriseAccountUseCase,
} from './provision-provisional-enterprise-account.use-case';

const API_KEY =
  'fma_live_0123456789abcdef_secreto-que-no-debe-registrarse-nunca-xx';

function buildDto(overrides: { documentsGranted?: number } = {}) {
  return {
    organization: {
      name: 'Acme Pruebas',
      organizationName: 'Acme Pruebas S.A. de C.V.',
      taxId: 'ACM010101AAA',
      domainAllowed: 'acme.test',
    },
    owner: { firstName: 'Ana', lastName: 'López', email: 'ana@acme.test' },
    billing: {
      documentsGranted: overrides.documentsGranted,
      periodStart: new Date('2026-11-01T00:00:00.000Z'),
      periodEnd: new Date('2027-11-01T00:00:00.000Z'),
      externalReference: 'PROVISION-ACME-TEST-001',
    },
    apiKeyName: 'Integración Enterprise Acme',
  };
}

describe('ProvisionProvisionalEnterpriseAccountUseCase', () => {
  const ownerRole = { id: 'role-owner', name: SYSTEM_ROLE_NAME_ENUM.OWNER };
  const permissions = [{ id: 'perm-1' }, { id: 'perm-2' }];
  const membership = {
    id: 'account-org',
    userId: 'user-1',
    organizationId: 'org-1',
    accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
    organization: { id: 'org-1' },
  };
  const owner = {
    user: {
      id: 'user-1',
      lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
    },
    personalAccount: { id: 'account-personal' },
    created: true,
  };

  /** Lo que se escribió y en qué orden: para comprobar que todo pasa por la transacción. */
  let steps: string[];
  let repositories: Map<unknown, Record<string, jest.Mock>>;
  let manager: {
    query: jest.Mock;
    getRepository: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let ownerProvisioning: { resolve: jest.Mock };
  let accountService: {
    saveOrganizationWithOwnerAccountWithin: jest.Mock;
    appendAccountToCatalog: jest.Mock;
  };
  let rolesService: { findSystemRoleByName: jest.Mock };
  let billingProvisioning: {
    ensureManualPlanExists: jest.Mock;
    createManualProfile: jest.Mock;
  };
  let registerManual: {
    findByExternalReference: jest.Mock;
    executeWithin: jest.Mock;
  };
  let issuePlatformApiKey: {
    resolvePermissionProfile: jest.Mock;
    issueWithin: jest.Mock;
  };
  let useCase: ProvisionProvisionalEnterpriseAccountUseCase;

  function record<T>(name: string, value: T) {
    return jest.fn(async () => {
      steps.push(name);
      return value;
    });
  }

  beforeEach(() => {
    steps = [];
    repositories = new Map<unknown, Record<string, jest.Mock>>([
      [
        PlatformProvisioningRequestEntity,
        {
          findOne: jest.fn().mockResolvedValue(null),
          insert: record('saveRequest', undefined),
        },
      ],
      [UserEntity, { findOneOrFail: jest.fn().mockResolvedValue(owner.user) }],
      [
        AccountEntity,
        {
          findOneOrFail: jest
            .fn()
            .mockResolvedValue({ ...membership, role: ownerRole }),
        },
      ],
      [
        BillingProfileEntity,
        {
          findOneOrFail: jest
            .fn()
            .mockResolvedValue({ id: 'bp-1', currentPlanType: 'enterprise' }),
        },
      ],
      [
        ApiKeyEntity,
        {
          findOneOrFail: jest
            .fn()
            .mockResolvedValue({ id: 'key-1', keyPrefix: 'fma_live_0123' }),
        },
      ],
    ]);
    const creditsQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ available: '1600' }),
    };
    manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn((entity) => repositories.get(entity)),
      createQueryBuilder: jest.fn(() => creditsQuery),
    };
    dataSource = {
      transaction: jest.fn(async (work) => work(manager)),
    };
    ownerProvisioning = { resolve: record('owner', owner) };
    accountService = {
      saveOrganizationWithOwnerAccountWithin: record(
        'organization',
        membership,
      ),
      appendAccountToCatalog: jest.fn().mockResolvedValue(undefined),
    };
    rolesService = {
      findSystemRoleByName: jest.fn().mockResolvedValue(ownerRole),
    };
    billingProvisioning = {
      ensureManualPlanExists: record('plan', undefined),
      createManualProfile: record('profile', { id: 'bp-1' }),
    };
    registerManual = {
      findByExternalReference: jest.fn().mockResolvedValue(null),
      executeWithin: record('period', {
        history: { id: 'history-1' },
        alreadyRegistered: false,
      }),
    };
    issuePlatformApiKey = {
      resolvePermissionProfile: jest.fn().mockResolvedValue(permissions),
      issueWithin: record('apiKey', {
        id: 'key-1',
        prefix: 'fma_live_0123',
        key: API_KEY,
      }),
    };

    useCase = new ProvisionProvisionalEnterpriseAccountUseCase(
      dataSource as never,
      ownerProvisioning as never,
      accountService as never,
      rolesService as never,
      billingProvisioning as never,
      registerManual as never,
      issuePlatformApiKey as never,
    );
  });

  it('crea usuario, organización, OWNER, perfil manual, créditos y llave en una sola transacción', async () => {
    const result = await useCase.execute({
      dto: buildDto() as never,
      idempotencyKey: 'prov-acme-001',
    });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([
      'owner',
      'organization',
      'plan',
      'profile',
      'period',
      'apiKey',
      'saveRequest',
    ]);
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
      [PROVISIONING_ADVISORY_LOCK_NAMESPACE, 'prov-acme-001'],
    );
    expect(ownerProvisioning.resolve).toHaveBeenCalledWith(manager, {
      email: 'ana@acme.test',
      firstName: 'Ana',
      lastName: 'López',
    });
    expect(
      accountService.saveOrganizationWithOwnerAccountWithin,
    ).toHaveBeenCalledWith(
      manager,
      owner.user,
      {
        name: 'Acme Pruebas',
        organizationName: 'Acme Pruebas S.A. de C.V.',
        taxId: 'ACM010101AAA',
        domainAllowed: 'acme.test',
      },
      ownerRole,
    );
    expect(billingProvisioning.createManualProfile).toHaveBeenCalledWith(
      manager,
      { personalAccountId: null, organizationId: 'org-1' },
    );
    expect(registerManual.executeWithin).toHaveBeenCalledWith(manager, {
      billingProfileId: 'bp-1',
      planType: 'enterprise',
      amount: 0,
      currency: 'mxn',
      periodStart: new Date('2026-11-01T00:00:00.000Z'),
      periodEnd: new Date('2027-11-01T00:00:00.000Z'),
      documentsGranted: 1600,
      externalReference: 'PROVISION-ACME-TEST-001',
      createdByUserId: null,
      notes: expect.any(String),
    });
    expect(issuePlatformApiKey.issueWithin).toHaveBeenCalledWith(manager, {
      organizationId: 'org-1',
      name: 'Integración Enterprise Acme',
      permissions,
    });

    expect(result).toEqual({
      success: true,
      message: 'Cuenta provisional aprovisionada correctamente',
      data: {
        organizationId: 'org-1',
        organizationAccountId: 'account-org',
        ownerUserId: 'user-1',
        ownerAccountId: 'account-personal',
        ownerLifecycleStatus: 'PROVISIONED',
        ownerRole: 'OWNER',
        billingProfileId: 'bp-1',
        planType: 'enterprise',
        documentsGranted: 1600,
        creditsAvailable: 1600,
        apiKeyId: 'key-1',
        apiKeyPrefix: 'fma_live_0123',
        apiKey: API_KEY,
        replayed: false,
      },
    });
  });

  it('pide a la llave el perfil completo de integración, decidido por el backend', async () => {
    await useCase.execute({
      dto: buildDto() as never,
      idempotencyKey: 'prov-acme-001',
    });

    expect(issuePlatformApiKey.resolvePermissionProfile).toHaveBeenCalledWith(
      DEFAULT_INTEGRATION_PERMISSION_KEYS,
    );
  });

  it('guarda la huella y lo creado, pero nunca la llave en claro', async () => {
    await useCase.execute({
      dto: buildDto() as never,
      idempotencyKey: 'prov-acme-001',
    });

    const insert = repositories.get(PlatformProvisioningRequestEntity)!.insert;
    expect(insert).toHaveBeenCalledWith({
      idempotencyKey: 'prov-acme-001',
      requestHash: buildProvisioningRequestHash(buildDto() as never),
      organizationId: 'org-1',
      organizationAccountId: 'account-org',
      ownerUserId: 'user-1',
      ownerAccountId: 'account-personal',
      billingProfileId: 'bp-1',
      apiKeyId: 'key-1',
      documentsGranted: 1600,
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain(API_KEY);
  });

  it('publica en el catálogo de Redis la cuenta personal nueva y la membresía, después del commit', async () => {
    await useCase.execute({
      dto: buildDto() as never,
      idempotencyKey: 'prov-acme-001',
    });

    expect(accountService.appendAccountToCatalog.mock.calls).toEqual([
      ['user-1', owner.personalAccount],
      ['user-1', membership],
    ]);
  });

  it('acredita los documentos pedidos en vez de 1600', async () => {
    await useCase.execute({
      dto: buildDto({ documentsGranted: 25 }) as never,
      idempotencyKey: 'prov-acme-001',
    });

    expect(registerManual.executeWithin).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ documentsGranted: 25 }),
    );
  });

  describe('idempotencia', () => {
    it('repite la respuesta sin escribir nada y sin la llave en claro', async () => {
      repositories
        .get(PlatformProvisioningRequestEntity)!
        .findOne.mockResolvedValue({
          idempotencyKey: 'prov-acme-001',
          requestHash: buildProvisioningRequestHash(buildDto() as never),
          organizationId: 'org-1',
          organizationAccountId: 'account-org',
          ownerUserId: 'user-1',
          ownerAccountId: 'account-personal',
          billingProfileId: 'bp-1',
          apiKeyId: 'key-1',
          documentsGranted: 1600,
        });

      const result = await useCase.execute({
        dto: buildDto() as never,
        idempotencyKey: 'prov-acme-001',
      });

      expect(steps).toEqual([]);
      expect(accountService.appendAccountToCatalog).not.toHaveBeenCalled();
      expect(result.data).toEqual(
        expect.objectContaining({
          organizationId: 'org-1',
          apiKeyId: 'key-1',
          apiKeyPrefix: 'fma_live_0123',
          apiKey: null,
          creditsAvailable: 1600,
          replayed: true,
        }),
      );
    });

    it('rechaza con 409 la misma clave con otros datos', async () => {
      repositories
        .get(PlatformProvisioningRequestEntity)!
        .findOne.mockResolvedValue({
          idempotencyKey: 'prov-acme-001',
          requestHash: buildProvisioningRequestHash(
            buildDto({ documentsGranted: 10 }) as never,
          ),
        });

      await expect(
        useCase.execute({
          dto: buildDto() as never,
          idempotencyKey: 'prov-acme-001',
        }),
      ).rejects.toBeInstanceOf(ProvisioningIdempotencyKeyMismatchException);
      expect(steps).toEqual([]);
    });

    it('da la misma huella con documentsGranted omitido que con 1600', () => {
      expect(buildProvisioningRequestHash(buildDto() as never)).toBe(
        buildProvisioningRequestHash(
          buildDto({ documentsGranted: 1600 }) as never,
        ),
      );
    });
  });

  describe('duplicados y rollback', () => {
    it('rechaza con 409 un folio ya registrado, sin crear nada', async () => {
      registerManual.findByExternalReference.mockResolvedValue({
        id: 'history-otro',
      });

      await expect(
        useCase.execute({
          dto: buildDto() as never,
          idempotencyKey: 'prov-acme-001',
        }),
      ).rejects.toBeInstanceOf(
        ProvisioningExternalReferenceAlreadyUsedException,
      );
      expect(steps).toEqual([]);
    });

    it('propaga el rechazo del propietario y no sigue', async () => {
      ownerProvisioning.resolve.mockRejectedValue(
        new ProvisionalOwnerEmailAlreadyRegisteredException(),
      );

      await expect(
        useCase.execute({
          dto: buildDto() as never,
          idempotencyKey: 'prov-acme-001',
        }),
      ).rejects.toBeInstanceOf(ProvisionalOwnerEmailAlreadyRegisteredException);
      expect(
        accountService.saveOrganizationWithOwnerAccountWithin,
      ).not.toHaveBeenCalled();
    });

    /**
     * El último paso falla con todo lo anterior ya escrito en la transacción: el error sale de
     * `dataSource.transaction` (que revierte) y no se registra la clave ni se toca Redis.
     */
    it('si falla la emisión de la llave, la transacción falla entera', async () => {
      issuePlatformApiKey.issueWithin.mockRejectedValue(
        new Error('INTEGRATION_API_KEY_HMAC_SECRET no configurado'),
      );

      await expect(
        useCase.execute({
          dto: buildDto() as never,
          idempotencyKey: 'prov-acme-001',
        }),
      ).rejects.toThrow('INTEGRATION_API_KEY_HMAC_SECRET no configurado');
      expect(steps).not.toContain('saveRequest');
      expect(accountService.appendAccountToCatalog).not.toHaveBeenCalled();
    });

    it('traduce a 409 el choque con otra petición simultánea', async () => {
      ownerProvisioning.resolve.mockRejectedValue({
        driverError: { code: '23505', detail: 'Key (email)=(ana@acme.test)' },
      });

      await expect(
        useCase.execute({
          dto: buildDto() as never,
          idempotencyKey: 'prov-acme-001',
        }),
      ).rejects.toBeInstanceOf(ConcurrentProvisioningException);
    });

    it('rechaza con 422 un periodo que no termina después de empezar, antes de abrir la transacción', async () => {
      const dto = buildDto();
      dto.billing.periodEnd = dto.billing.periodStart;

      await expect(
        useCase.execute({ dto: dto as never, idempotencyKey: 'prov-acme-001' }),
      ).rejects.toBeInstanceOf(ProvisioningInvalidBillingPeriodException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});

describe('DEFAULT_INTEGRATION_PERMISSION_KEYS', () => {
  it('es el perfil completo de integración pedido', () => {
    expect([...DEFAULT_INTEGRATION_PERMISSION_KEYS].sort()).toEqual(
      [
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_ORGANIZATION',
        'DOCUMENT.SEND_SIGNATURE_REQUEST',
        'DOCUMENT.CANCEL',
        'DIRECTORY.READ',
        'DIRECTORY.CREATE',
        'DIRECTORY.UPDATE',
        'DIRECTORY.DELETE',
      ].sort(),
    );
  });

  it('cabe en la lista blanca de API keys y no tiene nada administrativo ni READ_OWN', () => {
    for (const key of DEFAULT_INTEGRATION_PERMISSION_KEYS) {
      expect(API_KEY_ASSIGNABLE_PERMISSION_KEYS.has(key)).toBe(true);
      expect(API_KEY_FORBIDDEN_RESOURCES.has(key.split('.')[0])).toBe(false);
    }
    expect(DEFAULT_INTEGRATION_PERMISSION_KEYS).not.toContain(
      'DOCUMENT.READ_OWN',
    );
  });
});
