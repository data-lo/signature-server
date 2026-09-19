import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';

/**
 * Reglas de acceso a UN documento concreto, una vez cargado.
 *
 * `PermissionsGuard` ya respondió la pregunta general —"¿puede este rol leer documentos?"— y
 * dejó en el contexto los alcances concedidos. Lo que falta, y es lo único que hay aquí, es
 * confrontar esos alcances con el documento que se pidió: de qué organización es, quién lo creó,
 * quién participa en él.
 *
 * Esa separación no es ceremonia. El guard no puede decidir esto sin cargar el documento, y en
 * cuanto lo cargara dejaría de ser un guard general para volverse parte del dominio de
 * documentos; el caso de uso, por su parte, ya tiene el documento en la mano, que es
 * exactamente lo que hace falta.
 *
 * La Policy no consulta la base ni emite eventos: recibe el documento y el contexto, y responde
 * lanzando o no lanzando. Es lo que la hace probable sin levantar nada.
 */
@Injectable()
export class DocumentAuthorizationPolicy {
  /**
   * Comprueba que el contexto autorizado alcance para VER este documento.
   *
   * Se evalúan los dos alcances que el catálogo distingue para `DOCUMENT + READ`, en este orden:
   *
   * - `ORGANIZATION` (`DOCUMENT.READ_ORGANIZATION`): ver todo lo de la organización activa. Sólo
   *   sirve si el documento es de ESA organización — un documento de otra, o uno personal
   *   (`organizationId` nulo), no entra por aquí ni aunque el rol tenga el alcance.
   * - `OWN` (`DOCUMENT.READ_OWN`): ver lo propio o aquello donde se participa.
   *
   * Se prueban los dos porque un rol puede tener ambos, y el que sirva depende del documento:
   * un administrador con `ORGANIZATION` sigue necesitando `OWN` para ver un documento de su
   * cuenta personal.
   *
   * @param params.document - Documento ya cargado.
   * @param params.authorization - Contexto que dejó `PermissionsGuard`.
   * @param params.participant - Participación ya resuelta por el caso de uso, cuando la tiene.
   *   Se acepta porque enlazar a un colaborador invitado sólo por correo requiere una consulta
   *   (ver `DocumentService.resolveMyCollaborator`) que la Policy no debe hacer. Si no se pasa,
   *   la participación se deduce del propio documento con `isAccessibleBy`.
   *
   * @returns Nada: autorizar es no lanzar.
   *
   * @throws {ForbiddenException} (403) Si ningún alcance concedido cubre a este documento.
   *
   * @example
   * ```ts
   * this.authorizationPolicy.assertCanRead({ document, authorization });
   * ```
   */
  assertCanRead(params: {
    document: DocumentEntity;
    authorization: AuthorizationContext;
    participant?: CollaboratorEntity | null;
  }): void {
    const { document, authorization, participant } = params;

    const canReadOrganization = authorization.scopes.includes(
      PERMISSION_SCOPE_ENUM.ORGANIZATION,
    );

    if (
      canReadOrganization &&
      document.organizationId !== null &&
      document.organizationId === authorization.organizationId
    ) {
      return;
    }

    const canReadOwn = authorization.scopes.includes(PERMISSION_SCOPE_ENUM.OWN);

    if (
      canReadOwn &&
      this.isRelatedToUser(document, authorization, participant)
    ) {
      return;
    }

    throw new ForbiddenException(
      'No tienes permiso para consultar este documento',
    );
  }

  /**
   * Comprueba que el contexto autorizado alcance para FIRMAR este documento como participante.
   *
   * `SIGN + SELF` es el único alcance que el catálogo concede sobre la firma, y dice literalmente
   * "sólo en nombre propio": no basta con tener el permiso, hay que ser el firmante. Por eso se
   * exigen las tres cosas a la vez — el alcance, una participación y que esa participación sea la
   * del usuario autenticado, como firmante y no como observador o revisor.
   *
   * **No valida el estado del documento ni el turno.** Que esté pendiente, que le toque a esta
   * persona o que el código de verificación esté consumido son reglas del flujo de firma y viven
   * en su caso de uso: aquí se responde quién es, no cuándo puede.
   *
   * @param params.document - Documento ya cargado.
   * @param params.authorization - Contexto que dejó `PermissionsGuard`.
   * @param params.participant - Colaborador que el caso de uso resolvió para el usuario.
   *
   * @returns Nada: autorizar es no lanzar.
   *
   * @throws {ForbiddenException} (403) Si falta el alcance `SELF`, si el usuario no participa en
   *   el documento, o si participa con un rol que no firma.
   *
   * @example
   * ```ts
   * this.authorizationPolicy.assertCanSign({ document, authorization, participant });
   * ```
   */
  assertCanSign(params: {
    document: DocumentEntity;
    authorization: AuthorizationContext;
    participant?: CollaboratorEntity | null;
  }): void {
    const { authorization, participant } = params;

    const canSignSelf = authorization.scopes.includes(
      PERMISSION_SCOPE_ENUM.SELF,
    );

    const isAuthenticatedSigner =
      !!participant &&
      participant.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER &&
      participant.account?.userId === authorization.userId;

    if (canSignSelf && isAuthenticatedSigner) {
      return;
    }

    throw new ForbiddenException(
      'No tienes permiso para firmar este documento',
    );
  }

  /**
   * Si el usuario tiene una relación propia con el documento, usando la participación que el
   * caso de uso ya resolvió y cayendo al dato del documento cuando no la hay.
   *
   * @param document - Documento ya cargado.
   * @param authorization - Contexto autorizado de la petición.
   * @param participant - Participación resuelta por el caso de uso, si la hay.
   * @returns `true` si es creador o participante del documento.
   *
   * @example
   * ```ts
   * this.isRelatedToUser(document, authorization, participant); // true para el creador
   * ```
   */
  private isRelatedToUser(
    document: DocumentEntity,
    authorization: AuthorizationContext,
    participant?: CollaboratorEntity | null,
  ): boolean {
    if (participant) return true;

    return document.isAccessibleBy(authorization.userId);
  }
}
