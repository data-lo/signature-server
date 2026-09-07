import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './../src/shared/constants/api-prefix.constants';
import { PaymentsController } from './../src/payments/payments.controller';
import { GetPublicStripePlansUseCase } from './../src/payments/applications/get-public-stripe-plans.use-case';
import { GetSubscriptionStateUseCase } from './../src/payments/applications/get-subscription-state.use-case';
import { CreateSubscriptionCheckoutUseCase } from './../src/billing/checkout/create-subscription-checkout.use-case';
import { GetBillingStateUseCase } from './../src/billing/profiles/get-billing-state.use-case';
import { BillingOwnerService } from './../src/billing/profiles/billing-owner.service';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';
import { AccountEntity } from './../src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from './../src/account/enums/account-type.enum';
import { BILLING_PROFILE_STATUS_ENUM } from './../src/billing/enums/billing-profile-status.enum';
import {
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

const BILLING_STATE_ENDPOINT = '/api/v1/payments/billing-state';

const USER_ID = 'usuario-1';
const USER_EMAIL = 'firmante@ejemplo.com';
const PERSONAL_ACCOUNT_ID = 'cuenta-personal-1';
const ORGANIZATION_ACCOUNT_ID = 'cuenta-org-1';
const ORGANIZATION_ID = 'organizacion-1';
const AJENA_ACCOUNT_ID = 'cuenta-de-otro';

/** Sustituye al `JwtAuthGuard` global, que vive en `AuthModule` y no se importa acá. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = {
      sub: USER_ID,
      email: USER_EMAIL,
    };
    return true;
  }
}

/**
 * Estado de facturación visto desde fuera: `GET /api/v1/payments/billing-state`.
 *
 * Lo que sólo se comprueba por HTTP y no en la prueba unitaria es que la cuenta consultada sale
 * del header `X-Account-Id` y se traduce al propietario con el `BillingOwnerService` real contra
 * `accounts` — es decir, que una cuenta personal lee `personal_account_id` y una de organización
 * lee `organization_id`, que es toda la regla del endpoint.
 */
describe('Estado de facturación (e2e)', () => {
  let app: INestApplication;
  let accounts: InMemoryRepository<never>;
  let billingProfiles: InMemoryRepository<never>;

  function consultarEstado(accountId?: string | null) {
    const pending = request(app.getHttpServer()).get(BILLING_STATE_ENDPOINT);
    const header = accountId === undefined ? PERSONAL_ACCOUNT_ID : accountId;

    if (header !== null) {
      pending.set('X-Account-Id', header);
    }

    return pending.send();
  }

  async function darDeAltaPerfil(perfil: {
    id: string;
    personalAccountId?: string | null;
    organizationId?: string | null;
    status: BILLING_PROFILE_STATUS_ENUM;
    currentPlanType: string | null;
  }) {
    await billingProfiles.save({
      personalAccountId: null,
      organizationId: null,
      ...perfil,
    } as never);
  }

  beforeEach(async () => {
    accounts = createInMemoryRepository([
      {
        id: PERSONAL_ACCOUNT_ID,
        userId: USER_ID,
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        isActive: true,
      },
      {
        id: ORGANIZATION_ACCOUNT_ID,
        userId: USER_ID,
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: ORGANIZATION_ID,
        isActive: true,
      },
      {
        id: AJENA_ACCOUNT_ID,
        userId: 'otro-usuario',
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        isActive: true,
      },
    ] as never[]);

    billingProfiles = createInMemoryRepository();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        GetBillingStateUseCase,
        BillingOwnerService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        {
          provide: GetPublicStripePlansUseCase,
          useValue: { execute: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: GetSubscriptionStateUseCase,
          useValue: { execute: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: CreateSubscriptionCheckoutUseCase,
          useValue: { execute: jest.fn() },
        },
        { provide: getRepositoryToken(AccountEntity), useValue: accounts },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfiles,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('cuenta personal', () => {
    it('lee el perfil por personal_account_id', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'plus',
      });

      const response = await consultarEstado();

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        data: {
          billingProfileId: 'perfil-personal',
          hasActiveSubscription: true,
          currentPlanType: 'plus',
        },
      });
    });
  });

  describe('organización', () => {
    it('lee el perfil por organization_id', async () => {
      await darDeAltaPerfil({
        id: 'perfil-organizacion',
        organizationId: ORGANIZATION_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
      });

      const response = await consultarEstado(ORGANIZATION_ACCOUNT_ID);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        billingProfileId: 'perfil-organizacion',
        hasActiveSubscription: true,
        currentPlanType: 'premium',
      });
    });

    /**
     * El caso que justifica el header: el MISMO usuario tiene dos estados de facturación a la
     * vez y la respuesta depende de en cuál esté trabajando. Es lo que el endpoint anterior
     * —que resolvía la cuenta por la primera membresía activa— no podía distinguir.
     */
    it('devuelve estados distintos para la cuenta personal y la organización del mismo usuario', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.CANCELED,
        currentPlanType: 'basic',
      });
      await darDeAltaPerfil({
        id: 'perfil-organizacion',
        organizationId: ORGANIZATION_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
      });

      const personal = await consultarEstado();
      const organizacion = await consultarEstado(ORGANIZATION_ACCOUNT_ID);

      expect(personal.body.data).toEqual({
        billingProfileId: 'perfil-personal',
        hasActiveSubscription: false,
        currentPlanType: 'basic',
      });
      expect(organizacion.body.data).toEqual({
        billingProfileId: 'perfil-organizacion',
        hasActiveSubscription: true,
        currentPlanType: 'premium',
      });
    });
  });

  describe('perfil inexistente', () => {
    it('responde 200 con el estado vacío y sin crear el perfil', async () => {
      const response = await consultarEstado();

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        billingProfileId: null,
        hasActiveSubscription: false,
        currentPlanType: null,
      });
      // Consultar no da de alta: la tabla sigue vacía después de la petición.
      expect(billingProfiles.rows).toHaveLength(0);
    });
  });

  describe('estado del perfil', () => {
    it.each([
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])(
      'responde hasActiveSubscription=false con el perfil %s',
      async (status) => {
        await darDeAltaPerfil({
          id: 'perfil-personal',
          personalAccountId: PERSONAL_ACCOUNT_ID,
          status,
          currentPlanType: 'plus',
        });

        const response = await consultarEstado();

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({
          billingProfileId: 'perfil-personal',
          hasActiveSubscription: false,
          // El plan se conserva: sigue siendo el último contratado.
          currentPlanType: 'plus',
        });
      },
    );
  });

  describe('quién consulta', () => {
    it('responde 400 si falta el header X-Account-Id', async () => {
      const response = await consultarEstado(null);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Account-Id');
    });

    /** Sin esto, cambiar el header dejaría leer el plan de una cuenta ajena. */
    it('responde 403 si el usuario no pertenece a la cuenta del header', async () => {
      const response = await consultarEstado(AJENA_ACCOUNT_ID);

      expect(response.status).toBe(403);
    });

    it('responde 403 si la membresía está dada de baja', async () => {
      Object.assign(accounts.rows[0], { isActive: false });

      const response = await consultarEstado();

      expect(response.status).toBe(403);
    });
  });
});
