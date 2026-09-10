import { ForbiddenException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AssertPlanActionUseCase } from 'src/billing/entitlements/assert-plan-action.use-case';
import { GetBillingAccessUseCase } from 'src/billing/entitlements/get-billing-access.use-case';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from 'src/billing/subscriptions/subscription-billing-history.entity';
import { BillingOwnerService } from 'src/billing/profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import {
  MissingActiveAccountException,
  PlanActionNotIncludedException,
} from 'src/billing/exceptions/billing.exceptions';

import { AccountService } from '../account.service';
import {
  CreateOrganizationUseCase,
  ORGANIZATION_ACCOUNT_DENIED_MESSAGE,
} from './create-organization.use-case';

const USER_ID = 'user-1';
const ACTIVE_ACCOUNT_ID = 'account-activa-1';
const DTO = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

/** El propietario facturable de una cuenta personal, tal como lo devuelve `resolveOwner`. */
const OWNER = { personalAccountId: ACTIVE_ACCOUNT_ID, organizationId: null };

function perfilCon(currentPlanType: string) {
  return {
    id: 'perfil-1',
    currentPlanType,
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    cancelAtPeriodEnd: false,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  };
}

/**
 * El bloqueo comercial del alta de organizaciones, montado con la comprobación DE VERDAD.
 *
 * `AssertPlanActionUseCase` y `GetBillingAccessUseCase` son los reales, y lo único simulado es la
 * lectura de la base: es la única forma de que la prueba diga algo sobre el caso que más importa
 * —la cuenta que todavía no tiene `billing_profile`—, que con el permiso simulado sería
 * indistinguible de cualquier otro rechazo.
 *
 * `AccountService` sí va simulado, y a propósito: acá no se prueba el alta (eso es
 * `account.use-cases.spec.ts`), sino que el alta no llegue a ocurrir.
 */
describe('CreateOrganizationUseCase — bloqueo por plan', () => {
  let useCase: CreateOrganizationUseCase;
  let accountService: {
    findUserOrFail: jest.Mock;
    saveOrganizationWithAdminAccount: jest.Mock;
    appendAccountToCatalog: jest.Mock;
    toCatalogEntry: jest.Mock;
  };
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };

  beforeEach(async () => {
    accountService = {
      findUserOrFail: jest.fn().mockResolvedValue({ id: USER_ID }),
      saveOrganizationWithAdminAccount: jest
        .fn()
        .mockResolvedValue({ id: 'cuenta-nueva-1' }),
      appendAccountToCatalog: jest.fn().mockResolvedValue(undefined),
      toCatalogEntry: jest.fn().mockReturnValue({ id: 'cuenta-nueva-1' }),
    };

    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(OWNER),
      findProfileByOwner: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateOrganizationUseCase,
        AssertPlanActionUseCase,
        GetBillingAccessUseCase,
        { provide: AccountService, useValue: accountService },
        { provide: BillingOwnerService, useValue: billingOwnerService },
        {
          provide: getRepositoryToken(CreditLotEntity),
          useValue: { sum: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: getRepositoryToken(SubscriptionBillingHistoryEntity),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    useCase = module.get(CreateOrganizationUseCase);
  });

  const crear = () => useCase.execute(USER_ID, ACTIVE_ACCOUNT_ID, DTO);

  describe('cuenta con plan Free', () => {
    beforeEach(() => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilCon('free'),
      );
    });

    it('responde 403 con el mensaje que redactó producto', async () => {
      const fallo = await crear().catch(
        (error: PlanActionNotIncludedException) => error,
      );

      expect(fallo).toBeInstanceOf(PlanActionNotIncludedException);
      expect((fallo as PlanActionNotIncludedException).getStatus()).toBe(
        HttpStatus.FORBIDDEN,
      );
      expect(
        (fallo as PlanActionNotIncludedException).getResponse(),
      ).toMatchObject({ message: ORGANIZATION_ACCOUNT_DENIED_MESSAGE });
    });

    /**
     * El alta abre una transacción con dos escrituras y republica el catálogo en Redis. Que
     * termine lanzando no basta: nada de eso debe haber ocurrido.
     */
    it('no escribe nada: ni la organización, ni el catálogo', async () => {
      await expect(crear()).rejects.toThrow(PlanActionNotIncludedException);

      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).not.toHaveBeenCalled();
      expect(accountService.appendAccountToCatalog).not.toHaveBeenCalled();
      expect(accountService.findUserOrFail).not.toHaveBeenCalled();
    });
  });

  /**
   * Una cuenta que nunca pasó por facturación no tiene fila en `billing_profiles`, y preguntar
   * por su plan no debe crearla. Se trata como Free, que es lo que de hecho tiene.
   */
  describe('cuenta sin perfil de facturación', () => {
    it('responde 403 igual que una Free', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      const fallo = await crear().catch(
        (error: PlanActionNotIncludedException) => error,
      );

      expect(fallo).toBeInstanceOf(PlanActionNotIncludedException);
      expect((fallo as PlanActionNotIncludedException).getStatus()).toBe(
        HttpStatus.FORBIDDEN,
      );
      expect(
        (fallo as PlanActionNotIncludedException).getResponse(),
      ).toMatchObject({ message: ORGANIZATION_ACCOUNT_DENIED_MESSAGE });
      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).not.toHaveBeenCalled();
    });

    it('no da de alta el perfil por haber preguntado', async () => {
      await expect(crear()).rejects.toThrow(PlanActionNotIncludedException);

      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        OWNER,
      );
    });
  });

  /**
   * `plus` es el plan más barato que incluye `ORGANIZATION_ACCOUNT`. Se elige ése y no
   * `enterprise` justamente por eso: si algún día se le quitara el beneficio, esta prueba tiene
   * que enterarse.
   */
  describe('cuenta con plan permitido', () => {
    beforeEach(() => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilCon('plus'),
      );
    });

    it('deja continuar el flujo de alta', async () => {
      const resultado = await crear();

      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).toHaveBeenCalled();
      expect(accountService.appendAccountToCatalog).toHaveBeenCalled();
      expect(resultado.success).toBe(true);
    });
  });

  describe('de quién es el plan que se mira', () => {
    /**
     * Se autoriza contra la cuenta ACTIVA y no contra el usuario: el mismo usuario puede estar en
     * una organización con plan y tener su cuenta personal en Free.
     */
    it('resuelve el propietario de la cuenta activa que llega en la petición', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilCon('plus'),
      );

      await crear();

      expect(billingOwnerService.resolveOwner).toHaveBeenCalledWith(
        USER_ID,
        ACTIVE_ACCOUNT_ID,
      );
    });

    /** Mandar el `X-Account-Id` de una organización ajena no autoriza contra su plan. */
    it('propaga el 403 de una cuenta que no es del usuario', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(crear()).rejects.toThrow(ForbiddenException);
      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).not.toHaveBeenCalled();
    });

    it('rechaza la petición que no dice desde qué cuenta se pide', async () => {
      billingOwnerService.resolveOwner.mockImplementation(
        (_userId: string, accountId: string) => {
          if (!accountId) {
            throw new MissingActiveAccountException();
          }
          return Promise.resolve(OWNER);
        },
      );

      await expect(useCase.execute(USER_ID, '', DTO)).rejects.toThrow(
        MissingActiveAccountException,
      );
    });
  });
});
