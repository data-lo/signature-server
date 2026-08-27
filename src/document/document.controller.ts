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

// Use cases
import { GetDocumentFileUrlUseCase } from './applications/get-document-file-url.use-case';
import { GetPublicDocumentUseCase } from './applications/get-public-document.use-case';
import { GetPublicSealArtifactUseCase } from './applications/get-public-seal-artifact.use-case';
import { GetPublicAdvancedSignatureUseCase } from './applications/get-public-advanced-signature.use-case';
import { CreateDocumentUseCase } from './applications/create-document.use-case';
import { GetDocumentsUseCase } from './applications/get-documents.use-case';
import { GetDocumentUseCase } from './applications/get-document.use-case';
import { SubmitDocumentForAuthorizationUseCase } from './applications/submit-document-for-authorization.use-case';
import { SignDocumentUseCase } from './applications/sign-document.use-case';
import { LinkDocumentCollaboratorUseCase } from './applications/link-document-collaborator.use-case';
import { RequestDocumentVerificationCodeUseCase } from './applications/request-document-verification-code.use-case';
import { VerifyDocumentCodeUseCase } from './applications/verify-document-code.use-case';
import { RejectDocumentUseCase } from './applications/reject-document.use-case';
import { SubmitDocumentForCancellationUseCase } from './applications/submit-document-for-cancellation.use-case';
import { ConfirmDocumentCancellationUseCase } from './applications/confirm-document-cancellation.use-case';
import { UpdateDocumentUseCase } from './applications/update-document.use-case';
import { DeleteDocumentUseCase } from './applications/delete-document.use-case';

// Enums
import { SEAL_ARTIFACT_ENUM } from './seal/seal-artifacts';
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
import { ApiGetPublicSealArtifact } from './docs/api-get-public-seal-artifact.docs';

/**
 * El controller sólo traduce HTTP: cada endpoint delega en un caso de uso de `applications/`.
 */
@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(
    private readonly getDocumentFileUrl: GetDocumentFileUrlUseCase,
    private readonly getPublicDocument: GetPublicDocumentUseCase,
    private readonly getPublicSealArtifactUseCase: GetPublicSealArtifactUseCase,
    private readonly getPublicAdvancedSignature: GetPublicAdvancedSignatureUseCase,
    private readonly createDocument: CreateDocumentUseCase,
    private readonly getDocuments: GetDocumentsUseCase,
    private readonly getDocument: GetDocumentUseCase,
    private readonly submitForAuthorizationUseCase: SubmitDocumentForAuthorizationUseCase,
    private readonly signDocument: SignDocumentUseCase,
    private readonly linkDocumentCollaborator: LinkDocumentCollaboratorUseCase,
    private readonly requestDocumentVerificationCode: RequestDocumentVerificationCodeUseCase,
    private readonly verifyDocumentCode: VerifyDocumentCodeUseCase,
    private readonly rejectDocument: RejectDocumentUseCase,
    private readonly submitForCancellationUseCase: SubmitDocumentForCancellationUseCase,
    private readonly confirmCancellationUseCase: ConfirmDocumentCancellationUseCase,
    private readonly updateDocument: UpdateDocumentUseCase,
    private readonly deleteDocument: DeleteDocumentUseCase,
  ) {}

  @Get('file/:id')
  @ApiGetDocumentFileUrl()
  async getDocumentUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.getDocumentFileUrl.execute(id, user.sub);
  }

  @Get('public/:id')
  @SkipJwtAuth()
  @ApiGetPublicDocument()
  async getPublicDocumentView(@Param('id') id: string) {
    return this.getPublicDocument.execute(id);
  }

  @Get('public/:id/seal/:artifact')
  @SkipJwtAuth()
  @ApiGetPublicSealArtifact()
  async getPublicSealArtifact(
    @Param('id') id: string,
    @Param('artifact', new ParseEnumPipe(SEAL_ARTIFACT_ENUM))
    artifact: SEAL_ARTIFACT_ENUM,
    @Res() response: Response,
  ) {
    const { content, contentType, fileName } =
      await this.getPublicSealArtifactUseCase.execute(id, artifact);

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
    return this.getPublicAdvancedSignature.execute(id, collaboratorId);
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
    return await this.createDocument.execute(
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
    return this.getDocuments.execute(user.sub, accountId, query);
  }

  @Get(':id')
  @ApiGetDocument()
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.getDocument.execute(id, user.sub);
  }

  @Patch(':id/submit-for-authorization')
  @ApiSubmitDocumentForAuthorization()
  submitForAuthorization(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.submitForAuthorizationUseCase.execute(id, user.sub);
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
    return this.signDocument.execute(
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
    return this.linkDocumentCollaborator.execute(id, user.sub);
  }

  @Post(':id/verification-codes')
  @ApiRequestVerificationCode()
  @UseInterceptors(IpInterceptor)
  requestVerificationCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @ClientIp() ip: string,
  ) {
    return this.requestDocumentVerificationCode.execute(id, user.sub, ip);
  }

  @Post(':id/verification-codes/verify')
  @ApiVerifyDocumentCode()
  verifyCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VerifyCodeDto,
  ) {
    return this.verifyDocumentCode.execute(id, user.sub, dto.code);
  }

  @Patch(':id/reject')
  @ApiRejectDocument()
  reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectDocumentDto,
  ) {
    return this.rejectDocument.execute(id, user.sub, dto.reason);
  }

  @Patch(':id/submit-for-cancellation')
  @ApiSubmitDocumentForCancellation()
  submitForCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.submitForCancellationUseCase.execute(id, user.sub);
  }

  @Patch(':id/confirm-cancellation')
  @ApiConfirmDocumentCancellation()
  confirmCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.confirmCancellationUseCase.execute(id, user.sub);
  }

  @Patch(':id')
  @ApiUpdateDocument()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() signatureCoordinatesDto: SignatureCoordinatesDto,
  ) {
    return this.updateDocument.execute(id, user.sub, signatureCoordinatesDto);
  }

  @Delete(':id')
  @ApiDeleteDocument()
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.deleteDocument.execute(id, user.sub);
  }
}
