import { Injectable, NotFoundException } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserService } from '../user.service';

/**
 * Devuelve el perfil unificado con el que el cliente hidrata su store de onboarding
 * (`GET /api/v1/users/me`).
 *
 * Se sirve desde Redis DB 0 por CURP y no desde PostgreSQL porque esta lectura ocurre en cada carga
 * de la aplicación y sólo necesita un snapshot estable, sin joins ni URLs prefirmadas de MinIO, que
 * expiran y quedarían obsoletas dentro del cache.
 *
 * Si la key no está —fallo de Redis en el registro, TTL vencido, o borrada al cambiar el estado de la
 * credencial— reconstruye el snapshot desde PostgreSQL y lo vuelve a cachear: el cache frío es un
 * problema de rendimiento, no un 404.
 */
@Injectable()
export class GetMyProfileUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(curp: string): Promise<BaseResponse<unknown>> {
    const cached = await this.userService.readCachedProfile(curp);

    if (cached) {
      return {
        success: true,
        message: 'Usuario obtenido correctamente',
        data: cached,
      };
    }

    const user = await this.userService.findActiveByNationalId(curp);
    if (!user) {
      throw new NotFoundException(`Usuario con CURP ${curp} no encontrado`);
    }

    const payload = this.userService.buildProfileSnapshot(
      user,
      user.personalInformation,
    );

    await this.userService.refreshCurpCache(user, user.personalInformation);

    return {
      success: true,
      message: 'Usuario obtenido correctamente',
      data: payload,
    };
  }
}
