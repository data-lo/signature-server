import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CreateDocumentSignatureFlowUseCase } from './applications/create-document-signature-flow.use-case';
import { GetDocumentApproversUseCase } from './applications/get-document-approvers.use-case';
import { CreateDocumentSignaturesDto } from './dto/create-document-signatures.dto';

import { RequestIpInterceptor } from 'src/common/interceptors/request-ip.interceptor';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/common/constants/file-upload.constants';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { CurrentAuthorization } from 'src/authorization/decorators/current-authorization.decorator';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

// Docs
import { ApiCreateDocumentSignatureFlow } from './docs/api-create-document-signature-flow.docs';
import { ApiGetDocumentApprovers } from './docs/api-get-document-approvers.docs';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('documents')
export class DocumentSignaturesController {
  constructor(
    private readonly createDocumentSignatureFlow: CreateDocumentSignatureFlowUseCase,
    private readonly getDocumentApprovers: GetDocumentApproversUseCase,
  ) {}

  /**
   * Mismo permiso que `POST /document`. Antes este endpoint no declaraba ninguno y
   * `PermissionsGuard` lo dejaba pasar sin mirar el rol: cualquier miembro activo podía crear
   * documentos por esta vía aunque su rol no tuviera `DOCUMENT.CREATE`.
   */
  @Post('signatures')
  @ApiCreateDocumentSignatureFlow()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.CREATE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
      // Busboy decodifica campos de texto multipart como latin1 por defecto (ver
      // node_modules/busboy/lib/types/multipart.js) — sin esto, cualquier nombre con acento
      // (María, Pérez) llega mojibake y se corrompe también en Postgres. Encontrado probando
      // el payload real de la historia contra un servidor corriendo, no en los tests (los
      // mocks nunca pasan por Busboy). Multer sí reenvía esta opción a Busboy en tiempo de
      // ejecución (ver node_modules/multer/lib/make-middleware.js) — el `as` es porque el tipo
      // `MulterOptions` de @types/multer todavía no la declara.
      defParamCharset: 'utf8',
    } as Parameters<typeof FileInterceptor>[1]),
    RequestIpInterceptor,
  )
  async create(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: CreateDocumentSignaturesDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
  ) {
    return this.createDocumentSignatureFlow.execute(
      user.sub,
      accountId,
      dto,
      file,
      ip,
    );
  }

  /**
   * Aprobadores elegibles para "Requiere aprobación". Pide `DOCUMENT.CREATE` y no `MEMBER.READ`:
   * quien puede crear el documento tiene que poder configurarlo completo, sin que eso le abra el
   * listado de miembros (ver `GetDocumentApproversUseCase`).
   */
  @Get('approvers')
  @ApiGetDocumentApprovers()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.CREATE)
  findApprovers(@CurrentAuthorization() authorization: AuthorizationContext) {
    return this.getDocumentApprovers.execute(authorization);
  }
}
