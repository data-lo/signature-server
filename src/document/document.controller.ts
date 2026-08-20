// External dependencies
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Query,
  ParseEnumPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  FileInterceptor,
  FileFieldsInterceptor,
} from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';
import { RejectDocumentDto } from './dto/reject-document.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { SignDocumentDto } from './dto/sign-document.dto';
import { GetDocumentsQueryDto } from './dto/get-documents-query.dto';
import { SignatureCoordinatesDto } from './dto/signature-coordinates.dto';

// Services
import { DocumentService } from './document.service';

// Enums
import { IpInterceptor } from 'src/ip/ip.interceptor';
import { ClientIp } from 'src/ip/ip.decorator';

// Decorators
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

// Interfaces
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

// Docs
import { ApiGetDocumentFileUrl } from './docs/api-get-document-file-url.docs';
import { ApiGetPublicDocument } from './docs/api-get-public-document.docs';
import { ApiGetPublicAdvancedSignature } from './docs/api-get-public-advanced-signature.docs';
import { ApiCreateDocument } from './docs/api-create-document.docs';
import { ApiGetDocuments } from './docs/api-get-documents.docs';
import { ApiGetDocument } from './docs/api-get-document.docs';
import { ApiSubmitDocumentForAuthorization } from './docs/api-submit-document-for-authorization.docs';
import { ApiSignDocument } from './docs/api-sign-document.docs';
import { ApiLinkDocumentCollaborator } from './docs/api-link-document-collaborator.docs';
import { ApiRequestVerificationCode } from './docs/api-request-verification-code.docs';
import { ApiVerifyDocumentCode } from './docs/api-verify-document-code.docs';
import { ApiRejectDocument } from './docs/api-reject-document.docs';
import { ApiSubmitDocumentForCancellation } from './docs/api-submit-document-for-cancellation.docs';
import { ApiConfirmDocumentCancellation } from './docs/api-confirm-document-cancellation.docs';
import { ApiUpdateDocument } from './docs/api-update-document.docs';
import { ApiDeleteDocument } from './docs/api-delete-document.docs';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Get('file/:id')
  @ApiGetDocumentFileUrl()
  async getDocumentUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.documentService.assertUserHasAccess(id, user.sub);
    return this.documentService.getDocumentMinioURL(id);
  }

  @Get('public/:id')
  @SkipJwtAuth()
  @ApiGetPublicDocument()
  async getPublicDocument(@Param('id') id: string) {
    return this.documentService.getPublicDocumentView(id);
  }

  @Get('public/:id/seal/:artifact')
  @SkipJwtAuth()
  @ApiOperation({
    summary:
      'Descarga un artefacto de la constancia de conservación (sin autenticación)',
    description:
      'Público (sin JWT ni x-api-key, ver SkipJwtAuth) — respalda los botones de descarga de /public/documents/:id. Sirve lo que ya está guardado en document_seals y NO vuelve a llamar al PSC: Seal Service no persiste nada, así que esa fila es la única copia que existe. Responde 404 si el documento no está firmado, si no tiene sello (solo se sellan los documentos con firma avanzada, y el sellado es best-effort) o si ese artefacto en concreto no vino en la respuesta del proveedor.',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiParam({
    name: 'artifact',
    description:
      'Artefacto a descargar: nom151 (constancia en PDF), timestamp (token RFC 3161) o canonical (cadena canónica sellada, en texto plano — no es XML pese a como la nombra la historia, ver SEAL_ARTIFACT_ENUM).',
    enum: SEAL_ARTIFACT_ENUM,
  })
  @ApiResponse({ status: 200, description: 'Archivo del artefacto solicitado' })
  @ApiResponse({
    status: 404,
    description: 'Documento, constancia o artefacto no encontrado',
    type: NotFoundResponse,
  })
  async getPublicSealArtifact(
    @Param('id') id: string,
    @Param('artifact', new ParseEnumPipe(SEAL_ARTIFACT_ENUM))
    artifact: SEAL_ARTIFACT_ENUM,
    @Res() response: Response,
  ) {
    const { content, contentType, fileName } =
      await this.documentService.getPublicSealArtifact(id, artifact);

    response.setHeader('Content-Type', contentType);
    // `attachment`: son evidencia para guardar y verificar por fuera (openssl ts, un visor de PDF),
    // no algo que el navegador deba intentar renderizar dentro de la vista pública.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    );
    response.setHeader('Content-Length', String(content.length));
    response.send(content);
  }

  @Get('public/:id/signatures/:collaboratorId')
  @SkipJwtAuth()
  @ApiGetPublicAdvancedSignature()
  async getAdvancedSignature(
    @Param('id') id: string,
    @Param('collaboratorId') collaboratorId: string,
  ) {
    return this.documentService.getAdvancedSignaturePublicView(
      id,
      collaboratorId,
    );
  }

  @Post()
  @ApiCreateDocument()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
    }),
    IpInterceptor,
  )
  async create(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
  ) {
    return await this.documentService.create(
      user.sub,
      accountId,
      createDocumentDto,
      file,
      ip,
    );
  }

  @Get()
  @ApiGetDocuments()
  findAll(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Query() query: GetDocumentsQueryDto,
  ) {
    return this.documentService.findWithFilters(user.sub, accountId, query);
  }

  @Get(':id')
  @ApiGetDocument()
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.findDetailForUser(id, user.sub);
  }

  @Patch(':id/submit-for-authorization')
  @ApiSubmitDocumentForAuthorization()
  submitForAuthorization(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.submitForAuthorization(id, user.sub);
  }

  @Patch(':id/sign')
  @ApiSignDocument()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'key', maxCount: 1 },
        { name: 'cer', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES } },
    ),
  )
  sign(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SignDocumentDto,
    @UploadedFiles()
    files: { key?: Express.Multer.File[]; cer?: Express.Multer.File[] },
  ) {
    return this.documentService.sign(
      id,
      user.sub,
      {
        password: dto?.password,
        keyFile: files?.key?.[0],
        cerFile: files?.cer?.[0],
      },
      dto?.geolocation,
    );
  }

  @Patch(':id/link-collaborator')
  @ApiLinkDocumentCollaborator()
  linkCollaborator(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.linkPendingCollaboratorAccount(id, user.sub);
  }

  @Post(':id/verification-codes')
  @ApiRequestVerificationCode()
  @UseInterceptors(IpInterceptor)
  requestVerificationCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @ClientIp() ip: string,
  ) {
    return this.documentService.requestVerificationCode(id, user.sub, ip);
  }

  @Post(':id/verification-codes/verify')
  @ApiVerifyDocumentCode()
  verifyCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VerifyCodeDto,
  ) {
    return this.documentService.verifyCode(id, user.sub, dto.code);
  }

  @Patch(':id/reject')
  @ApiRejectDocument()
  reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectDocumentDto,
  ) {
    return this.documentService.reject(id, user.sub, dto.reason);
  }

  @Patch(':id/submit-for-cancellation')
  @ApiSubmitDocumentForCancellation()
  submitForCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.requestCancellation(id, user.sub);
  }

  @Patch(':id/confirm-cancellation')
  @ApiConfirmDocumentCancellation()
  confirmCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.confirmCancellation(id, user.sub);
  }

  @Patch(':id')
  @ApiUpdateDocument()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() signatureCoordinatesDto: SignatureCoordinatesDto,
  ) {
    return this.documentService.update(id, user.sub, signatureCoordinatesDto);
  }

  @Delete(':id')
  @ApiDeleteDocument()
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.remove(id, user.sub);
  }
}
