import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { BILLING_PROFILE_SOURCE_ENUM } from 'src/billing/enums/billing-profile-source.enum';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from 'src/billing/enums/credit-lot-origin.enum';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';

import { PlatformCreditGrantEntity } from '../entities/platform-credit-grant.entity';
import {
  CreditGrantExternalReferenceAlreadyUsedException,
  CreditGrantIdempotencyKeyMismatchException,
  CreditGrantOrganizationInactiveException,
  CreditGrantOrganizationNotFoundException,
  CreditGrantProfileNotEligibleException,
} from '../exceptions/platform.exceptions';
import {
  buildCreditGrantRequestHash,
  CREDIT_GRANT_ADVISORY_LOCK_NAMESPACE,
  CREDIT_GRANT_REPLAYED_MESSAGE,
  creditGrantMessage,
  GrantOrganizationCreditsUseCase,
} from './grant-organization-credits.use-case';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

function buildDto(overrides: Record<string, unknown> = {}) {
  return {
    documentsGranted: 500,
    externalReference: 'RECARGA-ACME-2026-001',
    notes: 'Recarga autorizada por contrato',
    ...overrides,
  };
}

describe('GrantOrganizationCreditsUseCase', () => {
  const profile = {
    id: 'bp-1',
    organizationId: ORGANIZATION_ID,
    currentPlanType: 'enterprise',
    billingSource: BILLING_PROFILE_SOURCE_ENUM.MANUAL,
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
  };

  let organizations: { findOne: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let lots: { create: jest.Mock; save: jest.Mock };
  let grants: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let creditsQuery: Record<string, jest.Mock>;
  let manager: {
    query: jest.Mock;
    getRepository: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let useCase: GrantOrganizationCreditsUseCase;

  function execute(dto = buildDto(), idempotencyKey = 'recarga-acme-001') {
    return useCase.execute({
      organizationId: ORGANIZATION_ID,
      dto: dto as never,
      idempotencyKey,
    });
  }

  beforeEach(() => {
    organizations = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID, isActive: true }),
    };
    profiles = { findOne: jest.fn().mockResolvedValue(profile) };
    lots = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: 'lot-1' })),
    };
    grants = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id: 'grant-1' })),
    };
    creditsQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ available: '530' }),
    };
    const repositories = new Map<unknown, unknown>([
      [OrganizationEntity, organizations],
      [BillingProfileEntity, profiles],
      [CreditLotEntity, lots],
      [PlatformCreditGrantEntity, grants],
    ]);
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity) => repositories.get(entity)),
      createQueryBuilder: jest.fn(() => creditsQuery),
    };
    dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    useCase = new GrantOrganizationCreditsUseCase(dataSource as never);
  });

  describe('recarga nueva', () => {
    it('crea un lote ADD_ON sin caducidad ni periodo y responde el saldo sumado', async () => {
      const result = await execute();

      expect(lots.create).toHaveBeenCalledWith({
        billingProfileId: 'bp-1',
        origin: CREDIT_LOT_ORIGIN_ENUM.ADD_ON,
        issued: 500,
        remaining: 500,
        priority: 0,
        stripeInvoiceId: null,
        stripePaymentIntentId: null,
        stripeSubscriptionId: null,
        periodStart: null,
        periodEnd: null,
        expiresAt: null,
      });
      expect(result).toEqual({
        success: true,
        message: creditGrantMessage(500),
        data: {
          grantId: 'grant-1',
          organizationId: ORGANIZATION_ID,
          billingProfileId: 'bp-1',
          creditLotId: 'lot-1',
          documentsGranted: 500,
          creditsAvailable: 530,
          externalReference: 'RECARGA-ACME-2026-001',
          replayed: false,
        },
      });
    });

    it('registra la constancia con el lote creado y la huella de la petición', async () => {
      await execute();

      expect(grants.create).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_ID,
        billingProfileId: 'bp-1',
        creditLotId: 'lot-1',
        documentsGranted: 500,
        externalReference: 'RECARGA-ACME-2026-001',
        idempotencyKey: 'recarga-acme-001',
        requestHash: buildCreditGrantRequestHash(
          ORGANIZATION_ID,
          buildDto() as never,
        ),
        notes: 'Recarga autorizada por contrato',
      });
    });

    it('serializa por clave y bloquea el perfil antes de escribir', async () => {
      await execute();

      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
        [CREDIT_GRANT_ADVISORY_LOCK_NAMESPACE, 'recarga-acme-001'],
      );
      expect(profiles.findOne).toHaveBeenCalledWith({
        where: { organizationId: ORGANIZATION_ID },
        lock: { mode: 'for_no_key_update' },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('guarda como null unas notas vacías o ausentes', async () => {
      await execute(buildDto({ notes: '' }));

      expect(grants.create).toHaveBeenCalledWith(
        expect.objectContaining({ notes: null }),
      );
    });
  });

  describe('validaciones de la organización', () => {
    it('responde 404 si la organización no existe', async () => {
      organizations.findOne.mockResolvedValue(null);

      await expect(execute()).rejects.toBeInstanceOf(
        CreditGrantOrganizationNotFoundException,
      );
      expect(lots.save).not.toHaveBeenCalled();
    });

    it('responde 422 si la organización está desactivada', async () => {
      organizations.findOne.mockResolvedValue({
        id: ORGANIZATION_ID,
        isActive: false,
      });

      await expect(execute()).rejects.toBeInstanceOf(
        CreditGrantOrganizationInactiveException,
      );
      expect(lots.save).not.toHaveBeenCalled();
    });

    it.each([
      ['sin perfil', null],
      ['con plan free', { ...profile, currentPlanType: 'free' }],
      ['sin plan', { ...profile, currentPlanType: null }],
      [
        'facturado por Stripe',
        { ...profile, billingSource: BILLING_PROFILE_SOURCE_ENUM.STRIPE },
      ],
      [
        'con la contratación sin completar',
        { ...profile, status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE },
      ],
      [
        'cancelado',
        { ...profile, status: BILLING_PROFILE_STATUS_ENUM.CANCELED },
      ],
    ])('responde 422 %s', async (_label, value) => {
      profiles.findOne.mockResolvedValue(value);

      await expect(execute()).rejects.toBeInstanceOf(
        CreditGrantProfileNotEligibleException,
      );
      expect(lots.save).not.toHaveBeenCalled();
      expect(grants.save).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia', () => {
    const previous = {
      id: 'grant-previo',
      organizationId: ORGANIZATION_ID,
      billingProfileId: 'bp-1',
      creditLotId: 'lot-previo',
      documentsGranted: 500,
      externalReference: 'RECARGA-ACME-2026-001',
      requestHash: buildCreditGrantRequestHash(
        ORGANIZATION_ID,
        buildDto() as never,
      ),
    };

    it('repetir la misma petición devuelve la recarga existente sin volver a acreditar', async () => {
      grants.findOne.mockResolvedValue(previous);

      const result = await execute();

      expect(result.message).toBe(CREDIT_GRANT_REPLAYED_MESSAGE);
      expect(result.data).toEqual({
        grantId: 'grant-previo',
        organizationId: ORGANIZATION_ID,
        billingProfileId: 'bp-1',
        creditLotId: 'lot-previo',
        documentsGranted: 500,
        creditsAvailable: 530,
        externalReference: 'RECARGA-ACME-2026-001',
        replayed: true,
      });
      expect(lots.save).not.toHaveBeenCalled();
      expect(grants.save).not.toHaveBeenCalled();
    });

    /** Un reintento tras un timeout no debe fallar porque la organización cambió después. */
    it('la repetición responde aunque la organización ya no sea elegible', async () => {
      grants.findOne.mockResolvedValue(previous);
      organizations.findOne.mockResolvedValue({
        id: ORGANIZATION_ID,
        isActive: false,
      });

      await expect(execute()).resolves.toMatchObject({
        data: { replayed: true },
      });
    });

    it('responde 409 si la clave se reutiliza con otro payload', async () => {
      grants.findOne.mockResolvedValue(previous);

      await expect(
        execute(buildDto({ documentsGranted: 501 })),
      ).rejects.toBeInstanceOf(CreditGrantIdempotencyKeyMismatchException);
      expect(lots.save).not.toHaveBeenCalled();
    });
  });

  describe('folio repetido', () => {
    function uniqueViolation(constraint: string) {
      return Object.assign(new Error('duplicate key'), {
        driverError: { code: '23505', constraint },
      });
    }

    it('traduce a 409 el choque contra el índice del folio', async () => {
      grants.save.mockRejectedValue(
        uniqueViolation('UQ_platform_credit_grants_external_reference'),
      );

      await expect(execute()).rejects.toBeInstanceOf(
        CreditGrantExternalReferenceAlreadyUsedException,
      );
    });

    it('propaga tal cual cualquier otro error de base de datos', async () => {
      const error = uniqueViolation('OTRO_INDICE');
      grants.save.mockRejectedValue(error);

      await expect(execute()).rejects.toBe(error);
    });
  });

  describe('buildCreditGrantRequestHash', () => {
    const hash = (organizationId: string, dto: Record<string, unknown>) =>
      buildCreditGrantRequestHash(organizationId, dto as never);

    it('no depende del orden de las claves del body', () => {
      expect(
        hash(ORGANIZATION_ID, {
          notes: 'x',
          externalReference: 'R-1',
          documentsGranted: 1,
        }),
      ).toBe(
        hash(ORGANIZATION_ID, {
          documentsGranted: 1,
          externalReference: 'R-1',
          notes: 'x',
        }),
      );
    });

    it('trata igual unas notas vacías que ausentes', () => {
      const base = { documentsGranted: 1, externalReference: 'R-1' };

      expect(hash(ORGANIZATION_ID, { ...base, notes: '' })).toBe(
        hash(ORGANIZATION_ID, base),
      );
    });

    it('cambia con la organización y con cada dato del body', () => {
      const original = hash(ORGANIZATION_ID, buildDto());

      expect(hash('otra-organizacion', buildDto())).not.toBe(original);
      expect(
        hash(ORGANIZATION_ID, buildDto({ documentsGranted: 501 })),
      ).not.toBe(original);
      expect(
        hash(ORGANIZATION_ID, buildDto({ externalReference: 'OTRO' })),
      ).not.toBe(original);
      expect(hash(ORGANIZATION_ID, buildDto({ notes: 'otra' }))).not.toBe(
        original,
      );
    });
  });
});
