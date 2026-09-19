import { ACTION_KEY_ENUM } from '../../roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from '../../roles/enums/resource-key.enum';

/**
 * Lo que un endpoint declara necesitar: un recurso y una acción del catálogo estático.
 *
 * **Sin scope a propósito.** El endpoint dice QUÉ acción ejerce sobre QUÉ recurso; sobre cuáles
 * instancias puede ejercerla lo determina el rol, y por eso el alcance viaja de vuelta en
 * `AuthorizationContext.scopes` en vez de exigirse aquí. Un mismo `DOCUMENT + READ` sirve a un
 * miembro que sólo ve lo suyo (`OWN`) y a un administrador que ve toda la organización
 * (`ORGANIZATION`): quien distingue entre los dos casos es la Policy del recurso, con el
 * documento ya cargado.
 */
export interface RequiredPermission {
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
}
