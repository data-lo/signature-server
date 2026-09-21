import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { getPersonalAccountPermissionScopes } from 'src/roles/personal-account-permissions';
import { RolesService } from 'src/roles/roles.service';

import { AuthorizationContext } from '../interfaces/authorization-context.interface';

/**
 * Cómo llega la cuenta activa en una petición.
 *
 * La plataforma tiene dos convenciones vivas y las dos son legítimas: las rutas anidadas bajo
 * `organizations/:organizationId/...` traen la organización en la ruta, y el resto la deduce de
 * la cuenta activa que el cliente manda en `X-Account-Id`. Ninguna de las dos es "la correcta a
 * futuro": la primera es explícita en la URL y la segunda es la única posible cuando el mismo
 * endpoint sirve a una cuenta personal y a una organización (documentos, facturación).
 *
 * Por eso `authorize` acepta las dos y resuelve SIEMPRE la misma fila: la membresía del usuario
 * autenticado. Quién es el usuario nunca sale de aquí — sale del JWT.
 */
export interface AuthorizeParams {
  /** Usuario autenticado (`JwtPayload.sub`). */
  userId: string;

  /** Organización activa, cuando viaja en la ruta o en `X-Organization-Id`. */
  organizationId?: string | null;

  /** Cuenta activa (`X-Account-Id`), cuando la organización no viaja explícita. */
  accountId?: string | null;

  /** Recurso declarado por el endpoint. */
  resource: RESOURCE_KEY_ENUM;

  /** Acción declarada por el endpoint. */
  action: ACTION_KEY_ENUM;
}

/**
 * Autorización general: resuelve el contexto de la petición y responde si la membresía activa
 * puede ejercer `resource + action`, y con qué alcances.
 *
 * Es deliberadamente corto en responsabilidades. Hace CUATRO cosas y ninguna más:
 *
 * 1. resuelve la membresía del usuario en la cuenta/organización activa,
 * 2. comprueba que esa membresía esté activa,
 * 3. resuelve los alcances concedidos para ese recurso y esa acción — contra el rol si la
 *    cuenta es de ORGANIZATION, contra el catálogo si es PERSONAL,
 * 4. devuelve el contexto, o lanza `ForbiddenException`.
 *
 * Lo que NO hace, y no debe empezar a hacer: cargar documentos, perfiles de facturación ni
 * ningún otro recurso de dominio; comprobar estados ("ya está firmado", "es su turno"); ni
 * comparar nombres de rol. Todo eso pertenece a la Policy del recurso, que trabaja sobre el
 * contexto que sale de aquí.
 *
 * **Una cuenta PERSONAL no pasa por `role_permissions`.** Sus permisos se derivan del catálogo
 * estático, recortado a lo que no exige una organización (ver `personal-account-permissions.ts`).
 * Es la única forma de que la persona pueda con lo suyo —su plan y sus documentos— sin heredar
 * la administración de una organización que no tiene, y de que una cuenta vieja a la que nunca
 * se le asignó rol siga funcionando.
 *
 * **Depende de que el catálogo esté sembrado, para las cuentas de organización.** Sus permisos
 * se leen de `role_permissions`, que llenan `npm run seed:roles` y
 * `npm run seed:static-permissions`; sobre una base sin el segundo, los permisos del catálogo
 * estático (BILLING, MEMBER, ROLE y los alcances de DOCUMENT) no existen y esta autorización
 * responde 403, que es la respuesta correcta a "el rol no tiene el permiso" aunque la causa real
 * sea operativa. Las cuentas personales no dependen del seed: su recorte del catálogo vive en
 * código.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    private readonly rolesService: RolesService,
  ) {}

  /**
   * Autoriza una petición y devuelve el contexto ya resuelto.
   *
   * @param params - Usuario autenticado, referencia a la cuenta activa (organización y/o cuenta)
   *   y el permiso que el endpoint declaró.
   * @returns El contexto autorizado, con los alcances concedidos.
   *
   * @throws {ForbiddenException} (403) Si no llega ninguna referencia de cuenta activa, si el
   *   usuario no tiene una membresía activa en ella, si esa membresía es de organización y no
   *   tiene rol, o si no tiene concedido `resource + action` con ningún alcance.
   *
   * @example
   * ```ts
   * const authorization = await authorizationService.authorize({
   *   userId: user.sub,
   *   accountId: request.headers['x-account-id'],
   *   resource: RESOURCE_KEY_ENUM.DOCUMENT,
   *   action: ACTION_KEY_ENUM.READ,
   * });
   * // { scopes: ['OWN'], roleId: '…', organizationId: '…', … }
   * ```
   */
  async authorize(params: AuthorizeParams): Promise<AuthorizationContext> {
    const membership = await this.resolveActiveMembership(params);
    const scopes = await this.resolveGrantedScopes(membership, params);

    if (scopes.length === 0) {
      throw new ForbiddenException(
        'No tienes permisos suficientes para realizar esta acción',
      );
    }

    return {
      userId: params.userId,
      organizationId: membership.organizationId,
      accountId: membership.id,
      roleId: membership.roleId,
      resource: params.resource,
      action: params.action,
      scopes,
    };
  }

  /**
   * Los alcances que la membresía activa tiene concedidos para el `resource + action` pedido.
   *
   * Es el punto donde se separan los dos mundos, y el único: una cuenta de ORGANIZATION se
   * resuelve contra su rol, exactamente como siempre, y una PERSONAL contra el catálogo
   * recortado. La decisión se toma por `accountType` y no por si hay `organizationId`, porque
   * el tipo es lo que declara qué es la cuenta; que una personal no tenga organización es una
   * consecuencia de eso, no la definición.
   *
   * Una cuenta PERSONAL sin rol se autoriza igual. `accounts.role_id` es nullable y hubo altas
   * que lo dejaron en NULL: exigirlo aquí dejaba a esas cuentas sin poder ni consultar su propio
   * plan, con un 403 que no describía ningún problema de permisos sino un hueco en el dato.
   *
   * @param membership - Membresía activa ya resuelta.
   * @param params - Los mismos parámetros que recibió `authorize`.
   * @returns Los alcances concedidos; vacío si no tiene el permiso.
   *
   * @throws {ForbiddenException} (403) Si la membresía es de organización y no tiene rol.
   *
   * @example
   * ```ts
   * await this.resolveGrantedScopes(personalAccount, {
   *   resource: RESOURCE_KEY_ENUM.BILLING,
   *   action: ACTION_KEY_ENUM.MANAGE,
   *   …
   * }); // ['ANY']
   * ```
   */
  private async resolveGrantedScopes(
    membership: AccountEntity,
    params: AuthorizeParams,
  ): Promise<PERMISSION_SCOPE_ENUM[]> {
    if (membership.accountType === ACCOUNT_TYPE_ENUM.PERSONAL) {
      return getPersonalAccountPermissionScopes(params.resource, params.action);
    }

    /**
     * Una membresía de organización sin rol no es un caso de error operativo sino una situación
     * prevista (`accounts.role_id` es nullable, reservado para invitaciones a medio completar):
     * no puede ejercer ninguna acción, y decirlo como 403 es lo que le corresponde.
     */
    if (!membership.roleId) {
      throw new ForbiddenException(
        'Tu membresía no tiene un rol asignado en esta cuenta',
      );
    }

    return this.rolesService.getPermissionScopes(
      membership.roleId,
      params.resource,
      params.action,
    );
  }

  /**
   * La fila de `accounts` desde la que actúa el usuario en esta petición.
   *
   * La organización de la ruta manda sobre la cuenta del header cuando llegan las dos: la URL es
   * lo que de verdad se está pidiendo, y un cliente con el header apuntando a otra organización
   * no debe poder operar sobre la de la ruta. Buscar por `userId + organizationId` cierra esa
   * puerta sola — sin coincidencia no hay membresía y la petición se rechaza.
   *
   * Cuando sólo hay `accountId`, se busca por `id + userId`: el header identifica la membresía,
   * pero que sea SUYA lo decide el JWT, no el cliente.
   *
   * @param params - Los mismos parámetros que recibió `authorize`.
   * @returns La membresía activa del usuario en la cuenta indicada.
   *
   * @throws {ForbiddenException} (403) Si no llega ninguna referencia, o si no existe una
   *   membresía activa del usuario para ella.
   *
   * @example
   * ```ts
   * const membership = await this.resolveActiveMembership({ userId, organizationId, … });
   * ```
   */
  private async resolveActiveMembership(
    params: AuthorizeParams,
  ): Promise<AccountEntity> {
    const { userId, organizationId, accountId } = params;

    if (!organizationId && !accountId) {
      throw new ForbiddenException(
        'No se pudo determinar la cuenta activa de la petición',
      );
    }

    const membership = await this.accountRepository.findOne({
      where: organizationId
        ? { userId, organizationId, isActive: true }
        : { id: accountId as string, userId, isActive: true },
    });

    /**
     * Mismo mensaje para "no eres miembro" y para "tu membresía está dada de baja". Distinguirlos
     * le diría a quien pregunta si una organización existe y quiénes la componen, que es
     * justamente lo que no puede saber quien no pertenece a ella.
     */
    if (!membership) {
      throw new ForbiddenException(
        'No tienes una membresía activa en esta cuenta',
      );
    }

    return membership;
  }
}
