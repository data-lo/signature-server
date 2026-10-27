import {
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
} from 'src/roles/static-permission-catalog';

import {
  API_KEY_ASSIGNABLE_PERMISSION_KEYS,
  API_KEY_FORBIDDEN_RESOURCES,
  isApiKeyAssignablePermission,
} from './api-key-permission-policy';

describe('api-key-permission-policy', () => {
  it('la lista blanca sólo nombra claves del catálogo estático', () => {
    for (const key of API_KEY_ASSIGNABLE_PERMISSION_KEYS) {
      expect(
        STATIC_PERMISSION_CATALOG[key as STATIC_PERMISSION_KEY_ENUM],
      ).toBeDefined();
    }
  });

  /** La red de seguridad: un permiso administrativo agregado por error a la lista falla aquí. */
  it('ningún permiso de la lista blanca es de un recurso administrativo', () => {
    for (const key of API_KEY_ASSIGNABLE_PERMISSION_KEYS) {
      const { resource } =
        STATIC_PERMISSION_CATALOG[key as STATIC_PERMISSION_KEY_ENUM];
      expect(API_KEY_FORBIDDEN_RESOURCES.has(resource)).toBe(false);
    }
  });

  it.each([
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
    STATIC_PERMISSION_KEY_ENUM.DIRECTORY_READ,
  ])('admite %s', (key) => {
    expect(isApiKeyAssignablePermission(key)).toBe(true);
  });

  it.each([
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
    STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_READ,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE,
    STATIC_PERMISSION_KEY_ENUM.ROLE_READ,
    STATIC_PERMISSION_KEY_ENUM.ROLE_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.API_KEY_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
  ])('rechaza %s', (key) => {
    expect(isApiKeyAssignablePermission(key)).toBe(false);
  });

  it('rechaza permisos fuera del catálogo, como la rejilla heredada', () => {
    expect(isApiKeyAssignablePermission('USER.DELETE')).toBe(false);
    expect(isApiKeyAssignablePermission('DOCUMENT.READ')).toBe(false);
  });
});
