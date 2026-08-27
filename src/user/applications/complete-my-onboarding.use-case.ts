import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdateUserStatusDto } from '../dto/update-user-status.dto';
import { UserService } from '../user.service';

/**
 * `PATCH /api/v1/users/me/status`: consolida el onboarding (`isConfigured=true`).
 *
 * @deprecated Sin consumidor. El frontend lo llamaba de forma automática para poder abrir la
 * pantalla de creación de documentos; ese bloqueo desapareció —crear un documento ya no depende
 * de nada— y firmar depende de `signingCredentialStatus`, que este endpoint no toca. Se
 * mantiene vivo para no romper a ningún cliente que todavía lo llame, pero la bandera que
 * escribe no habilita ninguna acción.
 *
 * Es un disparador de un solo sentido, no un toggle genérico de estado: por eso el valor que
 * llega en el DTO se ignora a propósito. Lo único que decide el resultado es si el usuario
 * cumple realmente las dos condiciones.
 *
 * Bug corregido (ver README, Historia 2): este endpoint confiaba al cien por ciento en que el
 * frontend sólo lo llamara cuando `personalConfigured` y `signatureConfigured` estuvieran de
 * verdad en true — no validaba nada del lado del servidor, así que cualquier petición
 * autenticada marcaba `isConfigured=true` sin importar el estado real de los datos. Las dos
 * condiciones se recalculan acá, con el mismo criterio que el frontend usa en `auth.slice.ts`:
 * teléfono más correo secundario, y `signatureId` presente.
 */
@Injectable()
export class CompleteMyOnboardingUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dto: UpdateUserStatusDto,
  ): Promise<BaseResponse<{ isConfigured: boolean }>> {
    const user = await this.userService.findOneWithPersonalInformation(userId);
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    const personalConfigured = !!(
      user.personalInformation?.phoneNumber &&
      user.personalInformation?.secondaryEmail
    );
    const signatureConfigured = !!user.signatureId;

    if (!personalConfigured || !signatureConfigured) {
      throw new BadRequestException(
        'No puedes consolidar el onboarding todavía: falta completar tu información personal o tu firma digital',
      );
    }

    await this.userService.markConfigured(userId);

    /**
     * Se relee en vez de mutar la copia en memoria: el snapshot que se cachea tiene que salir
     * de lo que quedó escrito, no de lo que este método supone que escribió.
     */
    const updatedUser =
      await this.userService.findOneWithPersonalInformation(userId);

    await this.userService.refreshCurpCache(
      updatedUser,
      updatedUser.personalInformation,
    );

    return {
      success: true,
      message: 'Estado de configuración actualizado correctamente',
      data: { isConfigured: true },
    };
  }
}
