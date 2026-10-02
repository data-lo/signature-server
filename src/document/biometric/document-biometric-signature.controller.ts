import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { CurrentAuthorization } from 'src/authorization/decorators/current-authorization.decorator';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { StartBiometricSignatureDto } from './dto/start-biometric-signature.dto';
import { StartBiometricSignatureUseCase } from './applications/start-biometric-signature.use-case';
import { GetBiometricSignatureStatusUseCase } from './applications/get-biometric-signature-status.use-case';
import {
  ApiGetBiometricSignatureStatus,
  ApiStartBiometricSignature,
} from './docs/api-biometric-signature.docs';

/**
 * Firma biométrica de un documento. Mismo permiso que `PATCH /document/:id/sign`
 * (`DOCUMENT + SIGN`): iniciar la biometría es el primer paso de firmar, y consultar su estado
 * sólo tiene sentido para quien puede firmar.
 *
 * El resultado NO entra por aquí: lo decide el webhook firmado de Didit (`POST /webhooks/didit`).
 */
@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentBiometricSignatureController {
  constructor(
    private readonly startBiometricSignature: StartBiometricSignatureUseCase,
    private readonly getBiometricSignatureStatus: GetBiometricSignatureStatusUseCase,
  ) {}

  @Post(':id/biometric-signature')
  @ApiStartBiometricSignature()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.SIGN)
  start(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: StartBiometricSignatureDto,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.startBiometricSignature.execute(
      id,
      user.sub,
      dto.geolocation,
      authorization,
    );
  }

  @Get(':id/biometric-signature')
  @ApiGetBiometricSignatureStatus()
  @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.SIGN)
  status(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.getBiometricSignatureStatus.execute(
      id,
      user.sub,
      authorization,
    );
  }
}
