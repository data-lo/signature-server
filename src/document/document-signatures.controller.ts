import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { DocumentSignaturesService } from './document-signatures.service';
import { CreateDocumentSignaturesDto } from './dto/create-document-signatures.dto';

import { IpInterceptor } from 'src/ip/ip.interceptor';
import { ClientIp } from 'src/ip/ip.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

// Docs
import { ApiCreateDocumentSignatureFlow } from './docs/api-create-document-signature-flow.docs';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('api/v1/documents')
export class DocumentSignaturesController {
  constructor(
    private readonly documentSignaturesService: DocumentSignaturesService,
  ) {}

  @Post('signatures')
  @ApiCreateDocumentSignatureFlow()
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
    IpInterceptor,
  )
  async create(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: CreateDocumentSignaturesDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
  ) {
    return this.documentSignaturesService.create(
      user.sub,
      accountId,
      dto,
      file,
      ip,
    );
  }
}
