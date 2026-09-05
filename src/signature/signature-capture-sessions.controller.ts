import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';

import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';
import { SignatureCaptureSessionCreated } from './interfaces/signature-capture-session-created.interface';
import { SignatureCaptureSessionStatus } from './interfaces/signature-capture-session-status.interface';

import { CreateSignatureCaptureSessionUseCase } from './applications/create-signature-capture-session.use-case';
import { ClaimMobileSignatureSessionUseCase } from './applications/claim-mobile-signature-session.use-case';
import { SaveHandwrittenSignatureUseCase } from './applications/save-handwritten-signature.use-case';
import { GetSignatureCaptureSessionStatusUseCase } from './applications/get-signature-capture-session-status.use-case';
import { CancelSignatureCaptureSessionUseCase } from './applications/cancel-signature-capture-session.use-case';

import { CreateSignatureCaptureSessionDto } from './dto/create-signature-capture-session.dto';
import { ClaimSignatureCaptureSessionDto } from './dto/claim-signature-capture-session.dto';

import { SIGNATURE_CAPTURE_FILE_FIELD } from './constants/signature-capture.constants';

import { ApiCreateSignatureCaptureSession } from './docs/api-create-signature-capture-session.docs';
import { ApiClaimSignatureCaptureSession } from './docs/api-claim-signature-capture-session.docs';
import { ApiGetSignatureCaptureSession } from './docs/api-get-signature-capture-session.docs';
import { ApiSaveHandwrittenSignature } from './docs/api-save-handwritten-signature.docs';
import { ApiCancelSignatureCaptureSession } from './docs/api-cancel-signature-capture-session.docs';

/**
 * Captura de la firma manuscrita, en la PC o en el teléfono.
 *
 * **Ningún endpoint acá es público.** El flujo cruza dos dispositivos, y lo que impide que el segundo
 * sea el de un desconocido es que el teléfono tenga que autenticarse como el mismo usuario antes de
 * tocar la sesión. Un endpoint de reclamo abierto "porque ya lleva un token secreto" convertiría
 * cualquier QR fotografiado en una firma ajena.
 *
 * El `userId` sale siempre de `@CurrentUser()`, nunca del cuerpo, del path ni del QR.
 *
 * Sólo traduce HTTP: cada endpoint delega en un caso de uso de `applications/`.
 */
@ApiTags('Signature Capture')
@ApiBearerAuth('access-token')
@Controller('signature-capture-sessions')
export class SignatureCaptureSessionsController {
  constructor(
    private readonly createSignatureCaptureSession: CreateSignatureCaptureSessionUseCase,
    private readonly claimMobileSignatureSession: ClaimMobileSignatureSessionUseCase,
    private readonly saveHandwrittenSignature: SaveHandwrittenSignatureUseCase,
    private readonly getSignatureCaptureSessionStatus: GetSignatureCaptureSessionStatusUseCase,
    private readonly cancelSignatureCaptureSession: CancelSignatureCaptureSessionUseCase,
  ) {}

  @Post()
  @ApiCreateSignatureCaptureSession()
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSignatureCaptureSessionDto,
  ): Promise<BaseResponse<SignatureCaptureSessionCreated>> {
    const data = await this.createSignatureCaptureSession.execute(
      user.sub,
      dto.channel,
    );

    return {
      success: true,
      message: data.reused
        ? 'Continúa la captura de firma que ya tenías abierta'
        : 'Captura de firma iniciada correctamente',
      data,
    };
  }

  /**
   * Va antes que `:id` por claridad de lectura, no por necesidad de enrutado: `claim` es un
   * segmento fijo y los endpoints con `:id` que comparten método tienen dos segmentos.
   */
  @Post('claim')
  @ApiClaimSignatureCaptureSession()
  async claim(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ClaimSignatureCaptureSessionDto,
  ): Promise<BaseResponse<SignatureCaptureSessionStatus>> {
    return {
      success: true,
      message: 'Captura de firma reclamada correctamente',
      data: await this.claimMobileSignatureSession.execute(user.sub, dto.token),
    };
  }

  @Get(':id')
  @ApiGetSignatureCaptureSession()
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<BaseResponse<SignatureCaptureSessionStatus>> {
    return {
      success: true,
      message: 'Estado de la captura obtenido correctamente',
      data: await this.getSignatureCaptureSessionStatus.execute(id, user.sub),
    };
  }

  /**
   * El `limits.fileSize` de multer es sólo el techo de seguridad compartido por todas las
   * subidas; el límite real del PNG lo aplica `SignatureService` más adelante, con el mensaje
   * concreto de ese tipo de archivo.
   */
  @Post(':id/signature')
  @ApiSaveHandwrittenSignature()
  @UseInterceptors(
    FileInterceptor(SIGNATURE_CAPTURE_FILE_FIELD, {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
    }),
  )
  saveSignature(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<BaseResponse<SignatureCaptureSessionStatus>> {
    return this.saveHandwrittenSignature.execute(id, user.sub, file);
  }

  @Post(':id/cancel')
  @ApiCancelSignatureCaptureSession()
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<BaseResponse<SignatureCaptureSessionStatus>> {
    return {
      success: true,
      message: 'Captura de firma cancelada correctamente',
      data: await this.cancelSignatureCaptureSession.execute(id, user.sub),
    };
  }
}
