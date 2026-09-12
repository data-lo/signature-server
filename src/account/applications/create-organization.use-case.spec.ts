import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MissingActiveAccountException } from 'src/billing/exceptions/billing.exceptions';

import { AccountService } from '../account.service';
import { AccountMemberService } from '../account-member.service';
import { CreateOrganizationUseCase } from './create-organization.use-case';

const USER_ID = 'user-1';
const ACTIVE_ACCOUNT_ID = 'account-activa-1';
const DTO = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };
const CURRENT_USER = { id: USER_ID, email: 'user1@empresa.com' };
const CREATED_ACCOUNT = { id: 'cuenta-nueva-1', organizationId: 'org-nueva-1' };
const CATALOG_ENTRY = { id: 'cuenta-nueva-1', type: 'ORGANIZATION' };

/**
 * El alta de organizaciones, sin restricción de plan.
 *
 * **El módulo de prueba no provee ningún servicio de facturación, y es a propósito.** Si el caso de
 * uso volviera a preguntar por el plan de la cuenta activa, Nest no podría construirlo y la prueba
 * fallaría antes de empezar: es la forma más directa de afirmar que crear una organización ya no
 * depende de estar en Free, de no tener perfil o de no tener suscripción.
 *
 * Lo que sí se conserva es la comprobación de pertenencia a la cuenta activa, que antes hacía de paso
 * la validación de plan.
 */
describe('CreateOrganizationUseCase', () => {
  let useCase: CreateOrganizationUseCase;
  let accountService: {
    findUserOrFail: jest.Mock;
    saveOrganizationWithAdminAccount: jest.Mock;
    appendAccountToCatalog: jest.Mock;
    toCatalogEntry: jest.Mock;
  };
  let accountMemberService: { assertIsActiveMember: jest.Mock };

  beforeEach(async () => {
    accountService = {
      findUserOrFail: jest.fn().mockResolvedValue(CURRENT_USER),
      saveOrganizationWithAdminAccount: jest
        .fn()
        .mockResolvedValue(CREATED_ACCOUNT),
      appendAccountToCatalog: jest.fn().mockResolvedValue(undefined),
      toCatalogEntry: jest.fn().mockReturnValue(CATALOG_ENTRY),
    };
    accountMemberService = {
      assertIsActiveMember: jest
        .fn()
        .mockResolvedValue({ id: ACTIVE_ACCOUNT_ID }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateOrganizationUseCase,
        { provide: AccountService, useValue: accountService },
        { provide: AccountMemberService, useValue: accountMemberService },
      ],
    }).compile();

    useCase = module.get(CreateOrganizationUseCase);
  });

  /**
   * Ejecuta el alta como la pediría el controlador.
   *
   * @param accountId - Valor del header `X-Account-Id`; `undefined` si no llegó.
   * @returns La respuesta del caso de uso.
   *
   * @example
   * await create(undefined); // lanza MissingActiveAccountException
   */
  const create = (accountId: string | undefined = ACTIVE_ACCOUNT_ID) =>
    useCase.execute(USER_ID, accountId as string, DTO);

  describe('sin restricción de plan', () => {
    it('crea la organización aunque la cuenta activa esté en Free o no tenga suscripción', async () => {
      await expect(create()).resolves.toEqual({
        success: true,
        message: 'Organización creada correctamente',
        data: CATALOG_ENTRY,
      });
      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).toHaveBeenCalledWith(CURRENT_USER, DTO);
    });

    it('publica la cuenta nueva en el catálogo de cuentas del usuario', async () => {
      await create();

      expect(accountService.appendAccountToCatalog).toHaveBeenCalledWith(
        USER_ID,
        CREATED_ACCOUNT,
      );
    });
  });

  describe('permisos que se conservan', () => {
    it('comprueba que el usuario pertenezca a la cuenta activa', async () => {
      await create();

      expect(accountMemberService.assertIsActiveMember).toHaveBeenCalledWith(
        USER_ID,
        ACTIVE_ACCOUNT_ID,
      );
    });

    it('responde 403 sin escribir nada si el usuario no pertenece a la cuenta activa', async () => {
      accountMemberService.assertIsActiveMember.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(create()).rejects.toThrow(ForbiddenException);
      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).not.toHaveBeenCalled();
      expect(accountService.appendAccountToCatalog).not.toHaveBeenCalled();
    });

    /**
     * Sin header no se llega a consultar la membresía: TypeORM trata un `id` indefinido como "sin
     * condición" y encontraría cualquier cuenta del usuario.
     */
    it('responde 400 sin consultar ni escribir nada si falta X-Account-Id', async () => {
      // Directo y no por `create`: su valor por defecto convertiría `undefined` en la cuenta activa.
      await expect(
        useCase.execute(USER_ID, undefined as unknown as string, DTO),
      ).rejects.toThrow(MissingActiveAccountException);
      expect(accountMemberService.assertIsActiveMember).not.toHaveBeenCalled();
      expect(
        accountService.saveOrganizationWithAdminAccount,
      ).not.toHaveBeenCalled();
    });
  });
});
