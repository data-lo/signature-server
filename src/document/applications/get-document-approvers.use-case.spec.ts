import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccountMemberService } from 'src/account/account-member.service';
import { REQUIRED_PERMISSION_METADATA } from 'src/authorization/constants/permission-metadata.constant';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DocumentSignaturesController } from '../document-signatures.controller';
import { GetDocumentApproversUseCase } from './get-document-approvers.use-case';

/**
 * Historia "Corregir carga de aprobadores al requerir aprobación durante la creación de
 * documentos".
 */
describe('GetDocumentApproversUseCase', () => {
  let accountMemberService: { listActiveMembersWithPermission: jest.Mock };
  let useCase: GetDocumentApproversUseCase;

  function authorization(organizationId: string | null): AuthorizationContext {
    return {
      userId: 'creator-1',
      organizationId,
      accountId: 'account-creator-1',
      roleId: organizationId ? 'member-role-1' : null,
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.CREATE,
      scopes: [PERMISSION_SCOPE_ENUM.ANY],
    };
  }

  beforeEach(() => {
    accountMemberService = {
      listActiveMembersWithPermission: jest.fn().mockResolvedValue([]),
    };
    useCase = new GetDocumentApproversUseCase(
      accountMemberService as unknown as AccountMemberService,
    );
  });

  it('pide los miembros con DOCUMENT.APPROVE de la organización del contexto, no de la petición', async () => {
    await useCase.execute(authorization('org-1'));

    expect(
      accountMemberService.listActiveMembersWithPermission,
    ).toHaveBeenCalledWith(
      'org-1',
      RESOURCE_KEY_ENUM.DOCUMENT,
      ACTION_KEY_ENUM.APPROVE,
    );
  });

  it('devuelve sólo id, correo y nombre de cada aprobador', async () => {
    accountMemberService.listActiveMembersWithPermission.mockResolvedValue([
      {
        id: 'account-1',
        userId: 'user-1',
        email: 'membresia@empresa.com',
        roleId: 'admin-role-1',
        status: 'active',
        user: {
          id: 'user-1',
          email: 'ana@empresa.com',
          firstName: 'Ana',
          lastName: 'Ruiz',
          nationalId: 'RUAA800101MDFRRN09',
        },
      },
    ]);

    const result = await useCase.execute(authorization('org-1'));

    expect(result.data).toEqual([
      {
        userId: 'user-1',
        email: 'ana@empresa.com',
        firstName: 'Ana',
        lastName: 'Ruiz',
      },
    ]);
  });

  it('rechaza con 400 desde una cuenta PERSONAL', async () => {
    await expect(useCase.execute(authorization(null))).rejects.toThrow(
      BadRequestException,
    );
    expect(
      accountMemberService.listActiveMembersWithPermission,
    ).not.toHaveBeenCalled();
  });

  /**
   * El permiso lo exige `PermissionsGuard` a partir de este metadato: sin él, el guard deja pasar
   * la petición sin mirar el rol.
   */
  describe('permiso declarado en el controlador', () => {
    const reflector = new Reflector();
    const requiredPermission = (handler: keyof DocumentSignaturesController) =>
      reflector.get(
        REQUIRED_PERMISSION_METADATA,
        DocumentSignaturesController.prototype[handler],
      );

    it('GET /documents/approvers exige DOCUMENT.CREATE, no MEMBER.READ', () => {
      expect(requiredPermission('findApprovers')).toEqual({
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.CREATE,
      });
    });

    it('POST /documents/signatures exige DOCUMENT.CREATE', () => {
      expect(requiredPermission('create')).toEqual({
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.CREATE,
      });
    });
  });
});
