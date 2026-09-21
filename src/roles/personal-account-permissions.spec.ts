import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import {
  getPersonalAccountPermissionScopes,
  isPersonalAccountPermission,
  PERSONAL_ACCOUNT_PERMISSION_KEYS,
} from './personal-account-permissions';
import {
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
} from './static-permission-catalog';

/**
 * Lo que se prueba aquí es el RECORTE del catálogo, no cómo se usa: qué claves se lleva una
 * cuenta personal y cuáles no. Que ese recorte llegue al menú y a los endpoints es de
 * `GetAuthorizationContextUseCase` y de `AuthorizationService`, que tienen sus propias pruebas.
 */
describe('permisos de una cuenta PERSONAL', () => {
  /**
   * La lista escrita a mano, deliberadamente: es la tabla de la historia, y si el recorte del
   * catálogo deja de coincidir con ella, esta prueba tiene que fallar. Derivarla del mismo
   * `organizationOnly` que usa el código no probaría nada.
   */
  it('son facturación y los documentos propios, y nada más', () => {
    expect([...PERSONAL_ACCOUNT_PERMISSION_KEYS]).toEqual([
      STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
      STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
    ]);
  });

  it.each([
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_READ,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE,
    STATIC_PERMISSION_KEY_ENUM.ROLE_READ,
    STATIC_PERMISSION_KEY_ENUM.ROLE_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
  ])('no incluye %s, que exige una organización detrás', (key) => {
    expect(isPersonalAccountPermission(key)).toBe(false);
  });

  /**
   * El recorte es una función del catálogo y no una lista paralela: cada clave está en uno de los
   * dos lados exactamente una vez. Si alguien agrega un permiso y olvida el recorte, el `false`
   * obligatorio de `organizationOnly` lo deja fuera y esta cuenta no se queda a medias.
   */
  it('cada clave del catálogo cae de un lado o del otro', () => {
    const keys = Object.keys(
      STATIC_PERMISSION_CATALOG,
    ) as STATIC_PERMISSION_KEY_ENUM[];

    const personal = keys.filter(isPersonalAccountPermission);
    const organizationOnly = keys.filter(
      (key) => !isPersonalAccountPermission(key),
    );

    expect(personal.length + organizationOnly.length).toBe(keys.length);
    expect(personal).toEqual([...PERSONAL_ACCOUNT_PERMISSION_KEYS]);
  });

  describe('alcances por recurso y acción', () => {
    /**
     * El caso que justifica que el recorte se aplique ANTES de quedarse con los alcances:
     * `DOCUMENT + READ` existe dos veces en el catálogo, y sin filtrar, una cuenta personal se
     * llevaría también el alcance de toda la organización.
     */
    it('leer documentos alcanza sólo a los propios, nunca a los de la organización', () => {
      expect(
        getPersonalAccountPermissionScopes(
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.READ,
        ),
      ).toEqual([PERMISSION_SCOPE_ENUM.OWN]);
    });

    it.each([
      [ACTION_KEY_ENUM.READ, PERMISSION_SCOPE_ENUM.ANY],
      [ACTION_KEY_ENUM.MANAGE, PERMISSION_SCOPE_ENUM.ANY],
    ])('facturación concede %s con alcance %s', (action, scope) => {
      expect(
        getPersonalAccountPermissionScopes(RESOURCE_KEY_ENUM.BILLING, action),
      ).toEqual([scope]);
    });

    it('firmar alcanza a uno mismo', () => {
      expect(
        getPersonalAccountPermissionScopes(
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.SIGN,
        ),
      ).toEqual([PERMISSION_SCOPE_ENUM.SELF]);
    });

    it.each([
      [RESOURCE_KEY_ENUM.MEMBER, ACTION_KEY_ENUM.READ],
      [RESOURCE_KEY_ENUM.ROLE, ACTION_KEY_ENUM.MANAGE],
      [RESOURCE_KEY_ENUM.ORGANIZATION, ACTION_KEY_ENUM.READ],
      [RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.APPROVE],
    ])('%s + %s no concede ningún alcance', (resource, action) => {
      expect(getPersonalAccountPermissionScopes(resource, action)).toEqual([]);
    });
  });
});
