import {
  normalizeCatalogDescription,
  RETIRED_CATALOG_PERMISSIONS,
  STATIC_CATALOG_ACTIONS,
  STATIC_CATALOG_RESOURCES,
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
  STATIC_ROLE_PERMISSION_MATRIX,
} from './static-permission-catalog';
import { buildPermissionKey } from './permission-catalog.util';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';

/**
 * El catálogo es un objeto literal, así que "probarlo" no es ejercitar lógica: es fijar el
 * contrato que la historia define —qué permisos existen, con qué texto y quién los trae— para que
 * un cambio accidental salte aquí y no en la pantalla de roles de un cliente.
 *
 * La tabla de abajo es la de la historia, copiada palabra por palabra.
 */
const CATALOG_TABLE: ReadonlyArray<[STATIC_PERMISSION_KEY_ENUM, string]> = [
  [
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
    'VER DATOS Y CONFIGURACIÓN DE LA ORGANIZACIÓN ACTIVA',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_UPDATE,
    'EDITAR DATOS Y CONFIGURACIÓN DE LA ORGANIZACIÓN',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
    'VER PLAN, PAGOS, FACTURAS Y ESTADO DE SUSCRIPCIÓN',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE,
    'INICIAR PAGO, CAMBIAR, CANCELAR O ADMINISTRAR EL PLAN',
  ],
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_READ, 'VER MIEMBROS'],
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE, 'INVITAR O AGREGAR MIEMBROS'],
  [
    STATIC_PERMISSION_KEY_ENUM.MEMBER_UPDATE,
    'CAMBIAR ROL O DATOS DE UN MIEMBRO',
  ],
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE, 'REVOCAR O ELIMINAR MEMBRESÍAS'],
  [STATIC_PERMISSION_KEY_ENUM.ROLE_READ, 'VER ROLES Y SUS PERMISOS'],
  [
    STATIC_PERMISSION_KEY_ENUM.ROLE_MANAGE,
    'CREAR O EDITAR ROLES PERSONALIZADOS',
  ],
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE, 'CREAR DOCUMENTOS'],
  [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    'VER DOCUMENTOS PROPIOS O DONDE PARTICIPA',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    'VER DOCUMENTOS DE TODA LA ORGANIZACIÓN',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
    'ENVIAR SOLICITUDES DE FIRMA',
  ],
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF, 'FIRMAR COMO PARTICIPANTE'],
  [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
    'APROBAR DOCUMENTOS, SI EL FLUJO LO REQUIERE',
  ],
  [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
    'SOLICITAR O CONFIRMAR CANCELACIONES, SEGÚN EL FLUJO',
  ],
];

describe('static-permission-catalog', () => {
  it('contiene exactamente los permisos de la tabla de la historia', () => {
    expect(Object.keys(STATIC_PERMISSION_CATALOG).sort()).toEqual(
      CATALOG_TABLE.map(([key]) => key).sort(),
    );
  });

  it.each(CATALOG_TABLE)('%s se describe como "%s"', (key, description) => {
    expect(STATIC_PERMISSION_CATALOG[key].description).toBe(description);
  });

  /**
   * La clave que publica la API se DERIVA del recurso, la acción y el alcance: si una definición
   * no concuerda con su clave, la pantalla mostraría un permiso con nombre de otro.
   */
  it.each(CATALOG_TABLE)(
    '%s concuerda con su recurso, acción y alcance',
    (key) => {
      const { resource, action, scope } = STATIC_PERMISSION_CATALOG[key];

      expect(buildPermissionKey(resource, action, scope)).toBe(key);
    },
  );

  describe('MAYÚSCULAS', () => {
    it('todas las descripciones del catálogo ya están en mayúsculas', () => {
      const descriptions = [
        ...Object.values(STATIC_CATALOG_RESOURCES),
        ...Object.values(STATIC_CATALOG_ACTIONS),
        ...Object.values(STATIC_PERMISSION_CATALOG).map(
          (definition) => definition.description,
        ),
      ];

      for (const description of descriptions) {
        expect(description).toBe(normalizeCatalogDescription(description));
      }
    });

    it('normalizeCatalogDescription recorta y sube a mayúsculas', () => {
      expect(normalizeCatalogDescription('  ver miembros ')).toBe(
        'VER MIEMBROS',
      );
      // Las vocales acentuadas se conservan acentuadas.
      expect(normalizeCatalogDescription('suscripción')).toBe('SUSCRIPCIÓN');
    });
  });

  describe('matriz de roles de sistema', () => {
    it('OWNER trae el catálogo completo', () => {
      expect(
        STATIC_ROLE_PERMISSION_MATRIX[SYSTEM_ROLE_NAME_ENUM.OWNER].sort(),
      ).toEqual(Object.values(STATIC_PERMISSION_KEY_ENUM).sort());
    });

    /** Lo único que separa a ADMIN de OWNER, como cuando esa fila se llamaba `MEMBER.DELETE`. */
    it('ADMIN trae todo menos MEMBER.REMOVE', () => {
      const admin = STATIC_ROLE_PERMISSION_MATRIX[SYSTEM_ROLE_NAME_ENUM.ADMIN];

      expect(admin).not.toContain(STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE);
      expect(admin.sort()).toEqual(
        Object.values(STATIC_PERMISSION_KEY_ENUM)
          .filter((key) => key !== STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE)
          .sort(),
      );
    });

    it('MEMBER conserva sólo sus tres capacidades iniciales', () => {
      expect(
        STATIC_ROLE_PERMISSION_MATRIX[SYSTEM_ROLE_NAME_ENUM.MEMBER],
      ).toEqual([
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
      ]);
    });

    it('ningún rol recibe una clave que no exista en el catálogo', () => {
      for (const keys of Object.values(STATIC_ROLE_PERMISSION_MATRIX)) {
        for (const key of keys) {
          expect(STATIC_PERMISSION_CATALOG[key]).toBeDefined();
        }
      }
    });
  });

  describe('permisos retirados', () => {
    it('no vuelven a aparecer en el catálogo', () => {
      for (const retired of RETIRED_CATALOG_PERMISSIONS) {
        const revived = Object.values(STATIC_PERMISSION_CATALOG).some(
          (definition) =>
            definition.resource === retired.resource &&
            definition.action === retired.action,
        );

        expect(revived).toBe(false);
      }
    });

    it('cada uno apunta a la clave que lo sustituye', () => {
      for (const retired of RETIRED_CATALOG_PERMISSIONS) {
        expect(STATIC_PERMISSION_CATALOG[retired.supersededBy]).toBeDefined();
      }
    });
  });
});
