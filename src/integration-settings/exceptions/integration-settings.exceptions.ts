import { HttpStatus, NotFoundException } from '@nestjs/common';

import { buildApiKeyErrorBody } from 'src/api-key/exceptions/api-key.exceptions';

/**
 * Códigos estables de la administración de la configuración de integración. Mismo cuerpo de error
 * que la administración de API keys (`statusCode`, `error`, `message`, `code`), porque las dos
 * pantallas viven juntas en Integraciones.
 */
export enum INTEGRATION_SETTINGS_ERROR_CODE_ENUM {
  ORGANIZATION_NOT_FOUND = 'ORGANIZATION_NOT_FOUND',
  INTEGRATION_SETTINGS_INVALID_BODY = 'INTEGRATION_SETTINGS_INVALID_BODY',
}

/** La organización de la ruta no existe o está desactivada. */
export class IntegrationSettingsOrganizationNotFoundException extends NotFoundException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.NOT_FOUND,
        'Not Found',
        'La organización no existe',
        INTEGRATION_SETTINGS_ERROR_CODE_ENUM.ORGANIZATION_NOT_FOUND,
      ),
    );
  }
}
