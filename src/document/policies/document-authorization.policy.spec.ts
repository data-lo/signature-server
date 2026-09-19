import { ForbiddenException } from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DocumentAuthorizationPolicy } from './document-authorization.policy';

/**
 * La Policy no toca la base ni Nest: recibe un documento y un contexto, y responde. Por eso se
 * instancia a mano, sin módulo de pruebas.
 *
 * Los documentos se construyen como instancias REALES de `DocumentEntity` porque la Policy usa
 * `isAccessibleBy`, que es un método de la entidad: con un objeto plano la prueba comprobaría
 * otra cosa.
 */
describe('DocumentAuthorizationPolicy', () => {
  const policy = new DocumentAuthorizationPolicy();

  const CREATOR_ID = 'user-creator';
  const SIGNER_ID = 'user-signer';
  const OUTSIDER_ID = 'user-outsider';

  function buildAuthorization(
    scopes: PERMISSION_SCOPE_ENUM[],
    overrides: Partial<AuthorizationContext> = {},
  ): AuthorizationContext {
    return {
      userId: OUTSIDER_ID,
      organizationId: 'org-1',
      accountId: 'account-1',
      roleId: 'role-1',
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
      scopes,
      ...overrides,
    };
  }

  function buildSigner(
    userId: string | null,
    overrides: Partial<CollaboratorEntity> = {},
  ): CollaboratorEntity {
    return Object.assign(new CollaboratorEntity(), {
      id: `collaborator-${userId ?? 'sin-cuenta'}`,
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      account: userId ? ({ userId } as CollaboratorEntity['account']) : null,
      ...overrides,
    });
  }

  function buildDocument(
    overrides: Partial<DocumentEntity> = {},
  ): DocumentEntity {
    return Object.assign(new DocumentEntity(), {
      id: 'doc-1',
      createdBy: CREATOR_ID,
      organizationId: 'org-1',
      collaborators: [buildSigner(SIGNER_ID)],
      ...overrides,
    });
  }

  describe('assertCanRead', () => {
    it('permite READ + ORGANIZATION sobre un documento de la organización activa', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument(),
          authorization: buildAuthorization([
            PERMISSION_SCOPE_ENUM.ORGANIZATION,
          ]),
        }),
      ).not.toThrow();
    });

    /**
     * El alcance `ORGANIZATION` es "toda MI organización", no "cualquier organización". Sin esta
     * comprobación, un administrador de una organización leería los documentos de otra con sólo
     * cambiar el identificador de la URL.
     */
    it('impide acceder a un documento de otra organización aunque tenga READ + ORGANIZATION', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument({ organizationId: 'otra-organizacion' }),
          authorization: buildAuthorization([
            PERMISSION_SCOPE_ENUM.ORGANIZATION,
          ]),
        }),
      ).toThrow(ForbiddenException);
    });

    /**
     * Un documento de cuenta personal no tiene organización, así que no hay organización con la
     * que coincidir: leerlo exige `OWN`, tenga quien pregunte el alcance de organización o no.
     */
    it('no deja que READ + ORGANIZATION alcance a un documento personal', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument({ organizationId: null }),
          authorization: buildAuthorization([
            PERMISSION_SCOPE_ENUM.ORGANIZATION,
          ]),
        }),
      ).toThrow(ForbiddenException);
    });

    it('permite READ + OWN al creador del documento', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument(),
          authorization: buildAuthorization([PERMISSION_SCOPE_ENUM.OWN], {
            userId: CREATOR_ID,
          }),
        }),
      ).not.toThrow();
    });

    it('permite READ + OWN a un participante del documento', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument(),
          authorization: buildAuthorization([PERMISSION_SCOPE_ENUM.OWN], {
            userId: SIGNER_ID,
          }),
        }),
      ).not.toThrow();
    });

    /**
     * La participación que el caso de uso resolvió pesa sobre lo que diga el documento: es la
     * que contempla al colaborador invitado sólo por correo, cuya cuenta todavía no está
     * enlazada y que por lo tanto no aparece en `isAccessibleBy`.
     */
    it('permite READ + OWN con la participación que resolvió el caso de uso', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument({ collaborators: [] }),
          authorization: buildAuthorization([PERMISSION_SCOPE_ENUM.OWN], {
            userId: SIGNER_ID,
          }),
          participant: buildSigner(null, { email: 'firmante@correo.com' }),
        }),
      ).not.toThrow();
    });

    it('rechaza READ + OWN cuando el usuario no tiene relación con el documento', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument(),
          authorization: buildAuthorization([PERMISSION_SCOPE_ENUM.OWN]),
          participant: null,
        }),
      ).toThrow(ForbiddenException);
    });

    /**
     * Los dos alcances se prueban, no sólo el primero que aparezca: un administrador con
     * `ORGANIZATION` y `OWN` sigue necesitando el segundo para ver un documento suyo de cuenta
     * personal, que el primero no cubre.
     */
    it('cae en OWN cuando ORGANIZATION no cubre al documento', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument({ organizationId: null }),
          authorization: buildAuthorization(
            [PERMISSION_SCOPE_ENUM.ORGANIZATION, PERMISSION_SCOPE_ENUM.OWN],
            { userId: CREATOR_ID },
          ),
        }),
      ).not.toThrow();
    });

    it('rechaza cuando el rol no trae ningún alcance útil para leer', () => {
      expect(() =>
        policy.assertCanRead({
          document: buildDocument(),
          authorization: buildAuthorization([PERMISSION_SCOPE_ENUM.ANY], {
            userId: CREATOR_ID,
          }),
        }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertCanSign', () => {
    const signAuthorization = (
      scopes: PERMISSION_SCOPE_ENUM[],
      userId = SIGNER_ID,
    ) => buildAuthorization(scopes, { userId, action: ACTION_KEY_ENUM.SIGN });

    it('permite SIGN + SELF al participante autenticado', () => {
      expect(() =>
        policy.assertCanSign({
          document: buildDocument(),
          authorization: signAuthorization([PERMISSION_SCOPE_ENUM.SELF]),
          participant: buildSigner(SIGNER_ID),
        }),
      ).not.toThrow();
    });

    /**
     * El corazón de `SELF`: el permiso no basta: hay que ser quien firma. Aquí el participante
     * existe y es firmante, pero pertenece a OTRO usuario — el caso de alguien intentando firmar
     * en nombre ajeno.
     */
    it('rechaza SIGN + SELF cuando el participante es de otro usuario', () => {
      expect(() =>
        policy.assertCanSign({
          document: buildDocument(),
          authorization: signAuthorization([PERMISSION_SCOPE_ENUM.SELF]),
          participant: buildSigner(OUTSIDER_ID),
        }),
      ).toThrow(ForbiddenException);
    });

    it('rechaza SIGN + SELF cuando el usuario no participa en el documento', () => {
      expect(() =>
        policy.assertCanSign({
          document: buildDocument(),
          authorization: signAuthorization([PERMISSION_SCOPE_ENUM.SELF]),
          participant: null,
        }),
      ).toThrow(ForbiddenException);
    });

    it('rechaza SIGN + SELF a quien participa con un rol que no firma', () => {
      expect(() =>
        policy.assertCanSign({
          document: buildDocument(),
          authorization: signAuthorization([PERMISSION_SCOPE_ENUM.SELF]),
          participant: buildSigner(SIGNER_ID, {
            colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
          }),
        }),
      ).toThrow(ForbiddenException);
    });

    /**
     * Ser el firmante tampoco basta por sí solo: el alcance `SELF` es lo que el catálogo concede
     * con `DOCUMENT.SIGN_SELF`, y un rol al que se lo hayan quitado no firma aunque figure en el
     * documento.
     */
    it('rechaza al firmante cuyo rol no tiene el alcance SELF', () => {
      expect(() =>
        policy.assertCanSign({
          document: buildDocument(),
          authorization: signAuthorization([
            PERMISSION_SCOPE_ENUM.ORGANIZATION,
          ]),
          participant: buildSigner(SIGNER_ID),
        }),
      ).toThrow(ForbiddenException);
    });
  });
});
