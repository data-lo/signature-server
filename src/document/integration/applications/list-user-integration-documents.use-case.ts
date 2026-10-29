import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { apiKeyScopes } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DocumentReadService } from '../../services/document-read.service';
import { ListIntegrationDocumentsQueryDto } from '../dto/list-integration-documents-query.dto';
import {
  IntegrationScopeDeniedException,
  IntegrationUserNotFoundException,
} from '../exceptions/integration-document.exceptions';
import { IntegrationDocumentsPage } from '../interfaces/integration-document-response';

/**
 * `GET /api/v1/integration/users/:userId/documents`: documentos que creó un usuario dentro de la
 * organización de la API key.
 *
 * El guard exige `DOCUMENT.READ` con alcance `OWN` u `ORGANIZATION`; aquí se decide qué permite
 * cada uno:
 * - `ORGANIZATION` (o `ANY`): cualquier miembro activo de la organización de la llave.
 * - sólo `OWN`: únicamente el actor de la llave (`userId === apiClient.actorUserId`); cualquier
 *   otro, 403.
 *
 * El alcance se revisa antes que la membresía, para que una llave `OWN` no pueda usar el 403/404
 * para averiguar quién pertenece a la organización. Un usuario sin membresía activa en ESTA
 * organización —exista o no en otra— responde 404.
 */
@Injectable()
export class ListUserIntegrationDocumentsUseCase {
  constructor(
    private readonly documentReadService: DocumentReadService,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
  ) {}

  /**
   * Documentos de un miembro identificado por su correo (`GET /integration/documents?creatorEmail=`).
   * Resuelve el usuario sólo entre los miembros activos de la organización de la llave y aplica las
   * mismas reglas de alcance que `execute`.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @param creatorEmail - Correo del creador (se compara normalizado).
   * @param query - Paginación, orden y filtros.
   * @returns La página de documentos de ese creador.
   *
   * @throws {IntegrationUserNotFoundException} (404) Si el correo no es de un miembro activo de la
   *   organización (mismo error que un usuario inexistente).
   * @throws {IntegrationScopeDeniedException} (403) Si la llave sólo tiene alcance `OWN` y el correo
   *   no es el de su propio usuario.
   *
   * @example
   * ```ts
   * await listUserIntegrationDocuments.executeByEmail(apiClient, 'ana@acme.mx', { page: 1, limit: 25 });
   * ```
   */
  async executeByEmail(
    apiClient: IntegrationApiClient,
    creatorEmail: string,
    query: ListIntegrationDocumentsQueryDto,
  ): Promise<BaseResponse<IntegrationDocumentsPage>> {
    const membership = await this.accountRepository.findOne({
      where: {
        organizationId: apiClient.organizationId,
        isActive: true,
        user: { email: creatorEmail.trim().toLowerCase() },
      },
      relations: { user: true },
      select: { id: true, userId: true },
    });
    if (!membership) {
      throw new IntegrationUserNotFoundException();
    }
    return this.execute(apiClient, membership.userId, query);
  }

  /**
   * Lista una página de documentos creados por el usuario en la organización de la llave.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @param userId - `users.id` del creador.
   * @param query - Paginación, orden y filtros por estatus y fechas.
   * @returns La página de resúmenes y su paginación.
   *
   * @throws {IntegrationScopeDeniedException} (403) Si la llave sólo tiene `OWN` y `userId` no es
   *   su actor.
   * @throws {IntegrationUserNotFoundException} (404) Si el usuario no es miembro activo de la
   *   organización.
   * @throws {BadRequestException} (400) Si un rango de fechas está al revés.
   *
   * @example
   * ```ts
   * const { data } = await listUserIntegrationDocuments.execute(apiClient, 'user-1', { page: 1 });
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    userId: string,
    query: ListIntegrationDocumentsQueryDto,
  ): Promise<BaseResponse<IntegrationDocumentsPage>> {
    const scopes = apiKeyScopes(
      apiClient.permissions,
      RESOURCE_KEY_ENUM.DOCUMENT,
      ACTION_KEY_ENUM.READ,
    );
    const canReadOrganization =
      scopes.includes(PERMISSION_SCOPE_ENUM.ORGANIZATION) ||
      scopes.includes(PERMISSION_SCOPE_ENUM.ANY);

    if (!canReadOrganization && userId !== apiClient.actorUserId) {
      throw new IntegrationScopeDeniedException();
    }

    const isMember = await this.accountRepository.exists({
      where: {
        userId,
        organizationId: apiClient.organizationId,
        isActive: true,
      },
    });
    if (!isMember) {
      throw new IntegrationUserNotFoundException();
    }

    const data = await this.documentReadService.listOrganizationDocuments({
      organizationId: apiClient.organizationId,
      createdBy: userId,
      filters: query,
    });

    return {
      success: true,
      message: 'Documentos del usuario obtenidos correctamente',
      data,
    };
  }
}
