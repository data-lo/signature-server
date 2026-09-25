import {
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { AuthorizationService } from 'src/authorization/services/authorization.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DocumentEntity } from '../entities/document.entity';
import { DocumentAuthorizationPolicy } from '../policies/document-authorization.policy';
import { DocumentReadAccessService } from './document-read-access.service';

/**
 * La Policy va REAL y sólo `AuthorizationService` se simula: lo que se prueba es cuándo se hace
 * la segunda consulta y qué se decide con ella, no la Policy, que tiene su propia suite.
 */
describe('DocumentReadAccessService', () => {
  const ADMIN_ID = 'user-admin';
  let authorizationService: { authorize: jest.Mock };
  let service: DocumentReadAccessService;

  function buildAuthorization(
    organizationId: string | null,
    scopes: PERMISSION_SCOPE_ENUM[],
  ): AuthorizationContext {
    return {
      userId: ADMIN_ID,
      organizationId,
      accountId: `account-${organizationId ?? 'personal'}`,
      roleId: organizationId ? 'role-1' : null,
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
      scopes,
    };
  }

  function buildDocument(organizationId: string | null): DocumentEntity {
    return Object.assign(new DocumentEntity(), {
      id: 'doc-1',
      createdBy: 'user-creator',
      organizationId,
      collaborators: [],
    });
  }

  beforeEach(() => {
    authorizationService = {
      authorize: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException(
            'No tienes una membresía activa en esta cuenta',
          ),
        ),
    };
    service = new DocumentReadAccessService(
      new DocumentAuthorizationPolicy(),
      authorizationService as unknown as AuthorizationService,
    );
  });

  it('autoriza con el contexto activo sin consultar otra organización', async () => {
    await expect(
      service.assertCanRead({
        document: buildDocument('org-1'),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).resolves.toBeUndefined();

    expect(authorizationService.authorize).not.toHaveBeenCalled();
  });

  it('autoriza un documento de otra organización con el contexto del usuario en ESA organización', async () => {
    authorizationService.authorize.mockResolvedValue(
      buildAuthorization('org-2', [PERMISSION_SCOPE_ENUM.ORGANIZATION]),
    );

    await expect(
      service.assertCanRead({
        document: buildDocument('org-2'),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).resolves.toBeUndefined();

    expect(authorizationService.authorize).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      organizationId: 'org-2',
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
    });
  });

  it('relanza el 403 original si el usuario no es miembro de la organización del documento', async () => {
    await expect(
      service.assertCanRead({
        document: buildDocument('org-2'),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).rejects.toThrow('No tienes permiso para consultar este documento');
  });

  it('niega si en la organización del documento sólo tiene OWN y no se relaciona con él', async () => {
    authorizationService.authorize.mockResolvedValue(
      buildAuthorization('org-2', [PERMISSION_SCOPE_ENUM.OWN]),
    );

    await expect(
      service.assertCanRead({
        document: buildDocument('org-2'),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('no consulta nada más para un documento personal ajeno', async () => {
    await expect(
      service.assertCanRead({
        document: buildDocument(null),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(authorizationService.authorize).not.toHaveBeenCalled();
  });

  /** Un fallo que no es de permisos no se disfraza de 403: se deja subir tal cual. */
  it('deja pasar los errores que no son 403 al resolver la otra organización', async () => {
    authorizationService.authorize.mockRejectedValue(
      new InternalServerErrorException('base caída'),
    );

    await expect(
      service.assertCanRead({
        document: buildDocument('org-2'),
        authorization: buildAuthorization('org-1', [
          PERMISSION_SCOPE_ENUM.ORGANIZATION,
        ]),
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
