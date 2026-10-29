import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { AuthorizationService } from 'src/authorization/services/authorization.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentAuthorizationPolicy } from '../policies/document-authorization.policy';

/**
 * Decide si el usuario puede VER un documento ya cargado, contando con todas las organizaciones
 * en las que tiene permiso de lectura y no sólo con la activa.
 *
 * `PermissionsGuard` resuelve el contexto contra la cuenta activa, y la Policy compara el
 * documento con ESE contexto. Eso bastaba mientras el documento fuera de la organización activa,
 * pero dejaba fuera al administrador que abre un documento de otra de sus organizaciones —un
 * enlace de un correo, una pestaña abierta antes de cambiar de cuenta—: tenía
 * `DOCUMENT.READ_ORGANIZATION` justo en la organización del documento, y aun así recibía 403
 * porque la comparación se hacía contra otra.
 *
 * Por eso aquí se pregunta dos veces, en este orden:
 *
 * 1. Con el contexto de la petición, exactamente como antes. Es el caso común y no cuesta nada.
 * 2. Si eso no alcanzó y el documento es de OTRA organización, se resuelve el contexto del usuario
 *    en la organización del documento con el mismo `AuthorizationService` que usa el guard —misma
 *    membresía activa, mismo rol, mismos alcances— y se le vuelve a pasar a la Policy.
 *
 * No amplía nada que el catálogo no conceda: quien no es miembro activo de la organización del
 * documento, o lo es con un rol sin `DOCUMENT + READ`, sigue recibiendo el 403 original.
 */
@Injectable()
export class DocumentReadAccessService {
  constructor(
    private readonly authorizationPolicy: DocumentAuthorizationPolicy,
    private readonly authorizationService: AuthorizationService,
  ) {}

  /**
   * Comprueba que el usuario pueda ver el documento, primero desde la cuenta activa y después
   * desde la organización dueña del documento.
   *
   * @param params.document - Documento ya cargado (con `collaborators.account` si se quiere que
   *   la Policy deduzca la participación sin `participant`).
   * @param params.authorization - Contexto que dejó `PermissionsGuard` para la cuenta activa.
   * @param params.participant - Participación del usuario ya resuelta por el caso de uso, si la
   *   hay (ver `DocumentService.resolveMyCollaborator`).
   * @returns Nada: autorizar es no lanzar.
   *
   * @throws {ForbiddenException} (403) Si ni el contexto activo ni el de la organización del
   *   documento alcanzan. Se relanza el error del contexto activo, que es el que describe la
   *   petición tal como llegó.
   *
   * @example
   * ```ts
   * await this.readAccess.assertCanRead({ document, authorization, participant });
   * ```
   */
  async assertCanRead(params: {
    document: DocumentEntity;
    authorization: AuthorizationContext;
    participant?: CollaboratorEntity | null;
  }): Promise<void> {
    const { document, authorization, participant } = params;

    try {
      this.authorizationPolicy.assertCanRead(params);
      return;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;

      const documentOrganizationContext =
        await this.resolveDocumentOrganizationContext(document, authorization);

      if (!documentOrganizationContext) throw error;

      this.authorizationPolicy.assertCanRead({
        document,
        authorization: documentOrganizationContext,
        participant,
      });
    }
  }

  /**
   * El contexto de lectura del usuario en la organización del documento, cuando es otra distinta
   * de la activa y tiene ahí una membresía con `DOCUMENT + READ`.
   *
   * @param document - Documento ya cargado.
   * @param authorization - Contexto de la cuenta activa.
   * @returns El contexto en la organización del documento, o `null` si el documento es personal,
   *   es de la organización activa, o el usuario no tiene permiso de lectura en la suya.
   *
   * @example
   * ```ts
   * await this.resolveDocumentOrganizationContext(document, authorization); // { scopes: ['ORGANIZATION', 'OWN'], … }
   * ```
   */
  private async resolveDocumentOrganizationContext(
    document: DocumentEntity,
    authorization: AuthorizationContext,
  ): Promise<AuthorizationContext | null> {
    if (
      !document.organizationId ||
      document.organizationId === authorization.organizationId
    ) {
      return null;
    }

    try {
      return await this.authorizationService.authorize({
        userId: authorization.userId,
        organizationId: document.organizationId,
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
      });
    } catch (error) {
      if (error instanceof ForbiddenException) return null;
      throw error;
    }
  }
}
