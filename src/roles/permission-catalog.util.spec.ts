import { ActionEntity } from './entities/action.entity';
import { PermissionEntity } from './entities/permission.entity';
import { ResourceEntity } from './entities/resource.entity';
import {
  buildPermissionKey,
  comparePermissionKeys,
  describePermission,
  isStaticCatalogPermission,
  toPermissionData,
} from './permission-catalog.util';

const documentResource = {
  id: 'resource-1',
  key: 'DOCUMENT',
  description: 'Documentos para firma electrónica',
} as ResourceEntity;

const organizationResource = {
  id: 'resource-2',
  key: 'ORGANIZATION',
  description: 'Cuentas de tipo organización',
} as ResourceEntity;

const readAction = {
  id: 'action-1',
  key: 'READ',
  description: 'Consultar un recurso existente',
} as ActionEntity;

const signAction = {
  id: 'action-2',
  key: 'SIGN',
  description: 'Firmar un documento',
} as ActionEntity;

/**
 * La clave y la descripción de un permiso no son columnas: se derivan de recurso+acción+alcance.
 * Es lo que permite que la pantalla de miembros hable de capacidades ("Firmar en nombre propio")
 * sin agregar una migración para guardar ese texto.
 */
describe('permission-catalog.util', () => {
  describe('buildPermissionKey', () => {
    it('omite el alcance ANY y sufija cualquier otro', () => {
      expect(buildPermissionKey('DOCUMENT', 'CREATE', 'ANY')).toBe(
        'DOCUMENT.CREATE',
      );
      expect(buildPermissionKey('DOCUMENT', 'READ', 'OWN')).toBe(
        'DOCUMENT.READ_OWN',
      );
      expect(buildPermissionKey('DOCUMENT', 'READ', 'ORGANIZATION')).toBe(
        'DOCUMENT.READ_ORGANIZATION',
      );
    });
  });

  describe('describePermission', () => {
    it('usa el texto de negocio del catálogo estático', () => {
      expect(
        describePermission('DOCUMENT.SIGN_SELF', documentResource, signAction),
      ).toBe('Firmar en nombre propio e incluirse como firmante.');
    });

    /**
     * La rejilla CRUD que sembró `seed:roles` sigue existiendo en la base y ADMIN la tiene; si no
     * se describiera, la pantalla mostraría filas en blanco.
     */
    it('cae al texto genérico del recurso y la acción fuera del catálogo', () => {
      expect(
        describePermission(
          'ORGANIZATION.READ',
          organizationResource,
          readAction,
        ),
      ).toBe('Consultar un recurso existente — Cuentas de tipo organización');
    });
  });

  describe('comparePermissionKeys', () => {
    it('deja el catálogo estático primero, en el orden de la historia', () => {
      const keys = [
        'USER.DELETE',
        'MEMBER.INVITE',
        'ORGANIZATION.READ',
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_OWN',
      ];

      expect([...keys].sort(comparePermissionKeys)).toEqual([
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_OWN',
        'MEMBER.INVITE',
        'ORGANIZATION.READ',
        'USER.DELETE',
      ]);
    });
  });

  describe('isStaticCatalogPermission', () => {
    it('distingue el catálogo estático de la rejilla heredada', () => {
      expect(isStaticCatalogPermission('DOCUMENT.APPROVE')).toBe(true);
      expect(isStaticCatalogPermission('USER.DELETE')).toBe(false);
    });
  });

  describe('toPermissionData', () => {
    it('proyecta la fila con su clave, su descripción y si es del catálogo', () => {
      const permission = {
        id: 'permission-1',
        resourceId: documentResource.id,
        actionId: signAction.id,
        scope: 'SELF',
        resource: documentResource,
        action: signAction,
      } as PermissionEntity;

      expect(toPermissionData(permission)).toEqual({
        id: 'permission-1',
        key: 'DOCUMENT.SIGN_SELF',
        resource: 'DOCUMENT',
        action: 'SIGN',
        scope: 'SELF',
        description: 'Firmar en nombre propio e incluirse como firmante.',
        isStaticCatalog: true,
      });
    });

    /** Sin las relaciones cargadas la clave saldría como `undefined.undefined`, y en silencio. */
    it('falla si el permiso llega sin resource/action cargados', () => {
      const permission = {
        id: 'permission-1',
        scope: 'ANY',
      } as PermissionEntity;

      expect(() => toPermissionData(permission)).toThrow(TypeError);
    });
  });
});
