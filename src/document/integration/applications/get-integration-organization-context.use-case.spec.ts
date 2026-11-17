import { countAvailableCredits } from 'src/billing/credits/count-available-credits.util';
import { BILLING_PROFILE_STATUS_ENUM as STATUS } from 'src/billing/enums/billing-profile-status.enum';

import { GetIntegrationOrganizationContextUseCase } from './get-integration-organization-context.use-case';

jest.mock('src/billing/credits/count-available-credits.util');

const API_CLIENT = {
  apiKeyId: 'key-1',
  apiKeyName: 'ERP',
  organizationId: 'org-1',
  actorAccountId: null,
  actorUserId: null,
  permissions: [],
};

const PROFILE = {
  id: 'bp-1',
  status: STATUS.ACTIVE,
  cancelAtPeriodEnd: false,
  stripeCustomerId: 'cus_secreto',
  stripeSubscriptionId: 'sub_secreto',
  currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
  currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
  currentPlan: { name: 'Business', documentsIncluded: 7 },
};

describe('GetIntegrationOrganizationContextUseCase', () => {
  let organization: Record<string, unknown> | null;
  let profile: Record<string, unknown> | null;
  let lot: { issued: number } | null;
  let documentCount: jest.Mock;
  let creditLotFindOne: jest.Mock;

  const execute = async () => {
    const useCase = new GetIntegrationOrganizationContextUseCase(
      { findOne: jest.fn(async () => organization) } as never,
      { findOne: jest.fn(async () => profile) } as never,
      { findOne: creditLotFindOne, manager: {} } as never,
      { count: documentCount } as never,
    );
    return (await useCase.execute(API_CLIENT)).data!;
  };

  beforeEach(() => {
    organization = { id: 'org-1', name: 'Acme S.A. de C.V.' };
    profile = { ...PROFILE };
    lot = { issued: 1000 };
    documentCount = jest.fn(async () => 725);
    creditLotFindOne = jest.fn(async () => lot);
    jest.mocked(countAvailableCredits).mockResolvedValue(275);
  });

  it('arma el contexto con el saldo vigente y el resumen de facturación', async () => {
    await expect(execute()).resolves.toEqual({
      organization: {
        id: 'org-1',
        name: 'Acme S.A. de C.V.',
        status: 'active',
      },
      signatureQuota: {
        planLimit: 1000,
        documentsSigned: 725,
        documentsRemaining: 275,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
      },
      billing: {
        plan: 'Business',
        status: 'active',
        billingCycle: 'monthly',
        nextBillingDate: '2026-12-01',
        paymentStatus: 'paid',
      },
    });
  });

  it('no deja salir ningún dato de Stripe', async () => {
    expect(JSON.stringify(await execute())).not.toMatch(/cus_|sub_|stripe/i);
  });

  it('el límite sale del lote vigente, sin contar lotes de periodos anteriores', async () => {
    await execute();

    const [{ where }] = creditLotFindOne.mock.calls[0];
    expect(where[0]).toMatchObject({
      billingProfileId: 'bp-1',
      origin: 'CURRENT_PERIOD',
    });
    expect(where[0].periodEnd.type).toBe('moreThan');
    expect(where[1]).toEqual({
      billingProfileId: 'bp-1',
      origin: 'FREE_GRANT',
    });
  });

  it('sin lote cae a los documentos del plan', async () => {
    lot = null;

    const { signatureQuota } = await execute();
    expect(signatureQuota.planLimit).toBe(7);
  });

  it('con la cuota agotada devuelve documentsRemaining en 0', async () => {
    jest.mocked(countAvailableCredits).mockResolvedValue(0);

    const { signatureQuota } = await execute();
    expect(signatureQuota.documentsRemaining).toBe(0);
  });

  it('sin documentos firmados devuelve documentsSigned en 0', async () => {
    documentCount.mockResolvedValue(0);

    const { signatureQuota } = await execute();
    expect(signatureQuota.documentsSigned).toBe(0);
  });

  it('cuenta sólo documentos firmados de la organización dentro del periodo', async () => {
    await execute();

    const [{ where }] = documentCount.mock.calls[0];
    expect(where).toMatchObject({ organizationId: 'org-1', status: 'SIGNED' });
    expect(where.signedAt.type).toBe('and');
  });

  it('sin periodo vigente no cuenta firmados ni anuncia fechas', async () => {
    profile = {
      ...PROFILE,
      status: STATUS.FREE,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    };

    const { signatureQuota, billing } = await execute();

    expect(documentCount).not.toHaveBeenCalled();
    expect(signatureQuota).toMatchObject({
      documentsSigned: 0,
      periodStart: null,
      periodEnd: null,
    });
    expect(billing).toMatchObject({
      status: 'free',
      billingCycle: null,
      nextBillingDate: null,
      paymentStatus: 'not_applicable',
    });
  });

  it('una organización sin perfil responde en cero y sin plan', async () => {
    profile = null;

    await expect(execute()).resolves.toMatchObject({
      signatureQuota: {
        planLimit: 0,
        documentsSigned: 0,
        documentsRemaining: 0,
        periodStart: null,
        periodEnd: null,
      },
      billing: {
        plan: null,
        status: null,
        billingCycle: null,
        nextBillingDate: null,
        paymentStatus: 'not_applicable',
      },
    });
  });

  it.each([
    ['2026-01-01', '2026-02-01', 'monthly'],
    ['2026-02-01', '2026-03-01', 'monthly'],
    ['2026-11-01', '2027-11-01', 'yearly'],
    ['2026-11-01', '2027-02-01', 'custom'],
  ])('de %s a %s el ciclo es %s', async (start, end, billingCycle) => {
    profile = {
      ...PROFILE,
      currentPeriodStart: new Date(start),
      currentPeriodEnd: new Date(end),
    };

    await expect(execute()).resolves.toMatchObject({
      billing: { billingCycle },
    });
  });

  it.each([
    [STATUS.PAST_DUE, 'past_due', '2026-12-01'],
    [STATUS.INCOMPLETE, 'pending', null],
    [STATUS.CANCELED, 'not_applicable', null],
  ])('un perfil %s tiene pago %s', async (status, paymentStatus, next) => {
    profile = { ...PROFILE, status };

    await expect(execute()).resolves.toMatchObject({
      billing: {
        status: status.toLowerCase(),
        paymentStatus,
        nextBillingDate: next,
      },
    });
  });

  it('con la baja programada sigue pagado pero no anuncia otro cobro', async () => {
    profile = { ...PROFILE, cancelAtPeriodEnd: true };

    await expect(execute()).resolves.toMatchObject({
      billing: { paymentStatus: 'paid', nextBillingDate: null },
    });
  });
});
