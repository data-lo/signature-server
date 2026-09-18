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

const userResource = {
  id: 'resource-2',
  key: 'USER',
  description: 'USUARIOS DE LA PLATAFORMA',
} as ResourceEntity;

const readAction = {
  id: 'action-1',
  key: 'READ',
  description: 'CONSULTAR UN RECURSO EXISTENTE',
} as ActionEntity;

const signAction = {
  id: 'action-2',
  key: 'SIGN',
  description: 'Firmar un documento',
} as ActionEntity;

/**
 * La clave y la descripción de un permiso no son columnas: se derivan de recurso+acción+alcance.
 * Es lo que permite que la pantalla de miembros hable de capacidades ("FIRMAR COMO PARTICIPANTE")
 * sin agregar una migración para guardar ese texto. Todas viajan en MAYÚSCULAS.
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
      ).toBe('FIRMAR COMO PARTICIPANTE');
    });

    /**
     * La rejilla CRUD que sembró `seed:roles` sigue existiendo en la base sobre USER, que el
     * catálogo no gobierna; si no se describiera, la pantalla mostraría filas en blanco.
     */
    it('cae al texto genérico del recurso y la acción fuera del catálogo', () => {
      expect(describePermission('USER.READ', userResource, readAction)).toBe(
        'CONSULTAR UN RECURSO EXISTENTE — USUARIOS DE LA PLATAFORMA',
      );
    });

    /** Aunque la fila venga de una base sembrada antes de la regla de MAYÚSCULAS. */
    it('normaliza a MAYÚSCULAS el texto genérico que sale de la base', () => {
      expect(
        describePermission(
          'USER.READ',
          {
            ...userResource,
            description: 'Usuarios de la plataforma',
          } as ResourceEntity,
          {
            ...readAction,
            description: 'Consultar un recurso existente',
          } as ActionEntity,
        ),
      ).toBe('CONSULTAR UN RECURSO EXISTENTE — USUARIOS DE LA PLATAFORMA');
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

      // El orden lo manda el catálogo: ORGANIZATION y MEMBER van antes que DOCUMENT (ver
      // `STATIC_PERMISSION_CATALOG`), y lo ajeno al catálogo queda al final.
      expect([...keys].sort(comparePermissionKeys)).toEqual([
        'ORGANIZATION.READ',
        'MEMBER.INVITE',
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_OWN',
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
        description: 'FIRMAR COMO PARTICIPANTE',
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
