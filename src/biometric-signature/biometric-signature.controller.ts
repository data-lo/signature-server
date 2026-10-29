import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { CurrentAuthorization } from 'src/authorization/decorators/current-authorization.decorator';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ClientIp } from 'src/common/interceptors/request-ip.decorator';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { StartBiometricSignatureDto } from './dto/start-biometric-signature.dto';
import { StartAccountBiometricSignatureUseCase } from './applications/start-account-biometric-signature.use-case';
import { GetBiometricSignatureStatusUseCase } from './applications/get-biometric-signature-status.use-case';
import {
  ApiGetAccountBiometricSession,
  ApiStartAccountBiometricSession,
} from './docs/api-biometric-signature.docs';

/**
 * Firma biométrica del firmante CON cuenta. Mismo permiso que `PATCH /document/:id/sign`
 * (`DOCUMENT + SIGN`): iniciar la biometría es el primer paso de firmar.
 *
 * El resultado no entra por aquí: lo decide el webhook firmado de Didit (`POST /webhooks/didit`).
 */
@ApiTags('Biometric signature')
@ApiBearerAuth('access-token')
@Controller('documents/:documentId/biometric-signature')
export class BiometricSignatureController {
  constructor(
    private readonly startAccountSignature: StartAccountBiometricSignatureUseCase,
    private readonly getStatus: GetBiometricSignatureStatusUseCase,
  ) {}

  @Post('session')
  @ApiStartAccountBiometricSession()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.SIGN)
  start(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() dto: StartBiometricSignatureDto,
    @CurrentAuthorization() authorization: AuthorizationContext,
    @ClientIp() ipAddress: string,
  ) {
    return this.startAccountSignature.execute(
      documentId,
      user.sub,
      dto,
      authorization,
      ipAddress ?? null,
    );
  }

  @Get('session')
  @ApiGetAccountBiometricSession()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.SIGN)
  status(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.getStatus.forAccount(documentId, user.sub, authorization);
  }
}
