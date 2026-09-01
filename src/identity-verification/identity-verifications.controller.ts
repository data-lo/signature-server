import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { StartDiditVerificationUseCase } from './applications/start-didit-verification.use-case';
import { GetCurrentIdentityVerificationUseCase } from './applications/get-current-identity-verification.use-case';
import { CreateDiditSessionDto } from './dto/create-didit-session.dto';
import { StartedVerification } from './interfaces/started-verification.interface';
import { CurrentIdentityVerification } from './interfaces/current-verification.interface';
import { ApiStartDiditVerification } from './docs/api-start-didit-verification.docs';
import { ApiGetCurrentIdentityVerification } from './docs/api-get-current-identity-verification.docs';

/**
 * Endpoints autenticados de la pantalla "Identidad y firma".
 *
 * Acá NO se recibe el resultado de Didit: el veredicto llega por webhook firmado a
 * `POST /api/v1/webhooks/didit`, en el módulo `webhooks`. El callback del navegador sólo
 * devuelve al usuario a la aplicación, y por eso no existe un endpoint de callback en el
 * backend — si lo hubiera, cualquiera podría llamarlo para "aprobarse" a sí mismo.
 *
 * El controller sólo traduce HTTP: cada endpoint delega en un caso de uso de `applications/`.
 */
@ApiTags('Identity Verification')
@ApiBearerAuth('access-token')
@Controller('identity-verifications')
export class IdentityVerificationsController {
  constructor(
    private readonly startDiditVerification: StartDiditVerificationUseCase,
    private readonly getCurrentIdentityVerification: GetCurrentIdentityVerificationUseCase,
  ) {}

  @Post('didit/session')
  @ApiStartDiditVerification()
  async createDiditSession(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDiditSessionDto,
  ): Promise<BaseResponse<StartedVerification>> {
    const data = await this.startDiditVerification.execute(user.sub, dto);

    return {
      success: true,
      message: data.reused
        ? 'Continúa la verificación que ya tenías en curso'
        : 'Sesión de verificación creada correctamente',
      data,
    };
  }

  @Get('current')
  @ApiGetCurrentIdentityVerification()
  async current(
    @CurrentUser() user: JwtPayload,
  ): Promise<BaseResponse<CurrentIdentityVerification>> {
    return {
      success: true,
      message: 'Estado de verificación obtenido correctamente',
      data: await this.getCurrentIdentityVerification.execute(user.sub),
    };
  }
}
