import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { CurrentApiClient } from 'src/api-key/decorators/current-api-client.decorator';
import { RequireApiKeyPermission } from 'src/api-key/decorators/require-api-key-permission.decorator';
import { OrganizationApiKeyGuard } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/common/constants/file-upload.constants';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';
import { RequestIpInterceptor } from 'src/common/interceptors/request-ip.interceptor';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { CreateIntegrationDocumentUseCase } from './applications/create-integration-document.use-case';
import { ListOrganizationIntegrationDocumentsUseCase } from './applications/list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './applications/list-user-integration-documents.use-case';
import { ApiCreateIntegrationDocument } from './docs/api-create-integration-document.docs';
import { ApiListOrganizationIntegrationDocuments } from './docs/api-list-organization-integration-documents.docs';
import { ApiListUserIntegrationDocuments } from './docs/api-list-user-integration-documents.docs';
import { CreateIntegrationDocumentDto } from './dto/create-integration-document.dto';
import { ListIntegrationDocumentsQueryDto } from './dto/list-integration-documents-query.dto';
import { IntegrationUserNotFoundException } from './exceptions/integration-document.exceptions';
import {
  assertNoTenantOverrides,
  buildRequestFingerprint,
  readIdempotencyKey,
} from './utils/integration-request.util';

/** Header de la respuesta que dice si el alta fue una repetición de una petición anterior. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * API de integración de documentos para sistemas externos, autenticada con la API key de una
 * organización. Vive en `DocumentModule` pero separada de los controllers del frontend: no usa
 * JWT (`@SkipJwtAuth()`), ni `X-Account-Id`, ni el `ApiKeyGuard` global de la llave interna.
 *
 * `OrganizationApiKeyGuard` resuelve todo el contexto —organización, actor y permisos— desde la
 * llave y lo deja en `@CurrentApiClient()`. Cada ruta declara su permiso con
 * `@RequireApiKeyPermission` y, antes de nada, rechaza cualquier intento de elegir organización,
 * cuenta o autor (`assertNoTenantOverrides`).
 */
@ApiTags('Integration Documents')
@SkipJwtAuth()
@UseGuards(OrganizationApiKeyGuard)
@Controller('integration')
export class IntegrationDocumentsController {
  constructor(
    private readonly listOrganizationIntegrationDocuments: ListOrganizationIntegrationDocumentsUseCase,
    private readonly listUserIntegrationDocuments: ListUserIntegrationDocumentsUseCase,
    private readonly createIntegrationDocument: CreateIntegrationDocumentUseCase,
  ) {}

  @Get('documents')
  @ApiListOrganizationIntegrationDocuments()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ, [
    PERMISSION_SCOPE_ENUM.ORGANIZATION,
  ])
  listOrganizationDocuments(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Query() query: ListIntegrationDocumentsQueryDto,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.listOrganizationIntegrationDocuments.execute(apiClient, query);
  }

  /** Un `userId` que no es UUID no puede ser miembro de la organización: 404, igual que uno ajeno. */
  @Get('users/:userId/documents')
  @ApiListUserIntegrationDocuments()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ, [
    PERMISSION_SCOPE_ENUM.OWN,
    PERMISSION_SCOPE_ENUM.ORGANIZATION,
  ])
  listUserDocuments(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Param(
      'userId',
      new ParseUUIDPipe({
        exceptionFactory: () => new IntegrationUserNotFoundException(),
      }),
    )
    userId: string,
    @Query() query: ListIntegrationDocumentsQueryDto,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.listUserIntegrationDocuments.execute(apiClient, userId, query);
  }

  /** Mismas opciones de carga que `POST /documents/signatures` (ver `DocumentSignaturesController`). */
  @Post('documents')
  @ApiCreateIntegrationDocument()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.CREATE, [
    PERMISSION_SCOPE_ENUM.ORGANIZATION,
  ])
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
      defParamCharset: 'utf8',
    } as Parameters<typeof FileInterceptor>[1]),
    RequestIpInterceptor,
  )
  async createDocument(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Body() dto: CreateIntegrationDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertNoTenantOverrides(request);
    const idempotencyKey = readIdempotencyKey(idempotencyKeyHeader);
    if (!file) {
      throw new BadRequestException(
        'Falta el archivo PDF en el campo multipart `file`',
      );
    }

    const { replayed, ...result } =
      await this.createIntegrationDocument.execute({
        apiClient,
        payload: dto.payload,
        file,
        ip,
        idempotencyKey,
        requestHash: buildRequestFingerprint(file, request.body),
      });

    response.status(replayed ? 200 : 201);
    response.setHeader(IDEMPOTENT_REPLAYED_HEADER, String(replayed));
    return result;
  }
}
