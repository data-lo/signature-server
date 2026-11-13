import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';

/**
 * Cuerpo de `PATCH /organizations/:organizationId/integration-settings`.
 *
 * No acepta `organizationId`: la organización sale de la ruta autorizada, y el `ValidationPipe`
 * global (`whitelist`) descarta cualquier otro campo.
 */
export class UpdateIntegrationSettingsDto {
  @ApiProperty({
    enum: INTEGRATION_STATUS_ENUM,
    example: INTEGRATION_STATUS_ENUM.DISABLED,
    description:
      '`DISABLED` rechaza las peticiones nuevas de la API de integración con `403 INTEGRATION_DISABLED`; `ACTIVE` las vuelve a aceptar. No modifica las API keys.',
  })
  @IsEnum(INTEGRATION_STATUS_ENUM, {
    message: `status debe ser uno de: ${Object.values(INTEGRATION_STATUS_ENUM).join(', ')}`,
  })
  status: INTEGRATION_STATUS_ENUM;
}
