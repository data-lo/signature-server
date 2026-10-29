import { SetMetadata } from '@nestjs/common';

import { ACTION_KEY_ENUM } from '../../roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from '../../roles/enums/resource-key.enum';
import { REQUIRED_PERMISSION_METADATA } from '../constants/permission-metadata.constant';
import { RequiredPermission } from '../interfaces/required-permission.interface';

/**
 * Declara el permiso que exige un endpoint, en términos de recurso y acción del catálogo
 * estático.
 *
 * Es lo único que un controller dice sobre autorización: no compara roles, no resuelve la
 * organización activa y no consulta la base. De eso se encarga `PermissionsGuard`, que lee este
 * metadato y deja el contexto autorizado en la petición.
 *
 * Un endpoint SIN este decorador no se bloquea: el guard lo deja pasar tal cual. Es lo que
 * permite migrar los controllers de a poco en vez de tener que anotarlos todos de una vez.
 *
 * @param resource - Recurso sobre el que actúa el endpoint.
 * @param action - Acción que ejerce sobre él.
 * @returns El decorador de método/clase con el metadato ya fijado.
 *
 * @example
 * ```ts
 * @Get()
 * @RequirePermission(RESOURCE_KEY_ENUM.BILLING, ACTION_KEY_ENUM.READ)
 * getBillingSummary() {
 *   return this.getBillingSummaryUseCase.execute();
 * }
 * ```
 */
export const RequirePermission = (
  resource: RESOURCE_KEY_ENUM,
  action: ACTION_KEY_ENUM,
) =>
  SetMetadata(REQUIRED_PERMISSION_METADATA, {
    resource,
    action,
  } satisfies RequiredPermission);
