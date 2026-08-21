import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

/**
 * Recalcula y persiste `users.signing_credential_configured`.
 *
 * La regla es una sola y vive únicamente acá:
 *
 *     signingCredentialConfigured = (última verificación APPROVED) && (signatureId != null)
 *
 * Deliberadamente **recalcula** en vez de recibir el valor: es la única forma de que la bandera
 * no pueda desincronizarse. Cada disparador (aprobación de identidad, alta de firma, baja de
 * firma) llama a lo mismo y obtiene la misma respuesta, en lugar de que cada uno decida por su
 * cuenta y alguno se equivoque.
 */
@Injectable()
export class RefreshSigningCredentialStatusUseCase {
  private readonly logger = new Logger(
    RefreshSigningCredentialStatusUseCase.name,
  );

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
    private readonly redisService: RedisService,
  ) {}

  /** @returns El valor recalculado de la bandera. */
  async execute(userId: string): Promise<boolean> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return false;
    }

    const hasApprovedIdentity =
      await this.identityVerificationRepository.exists({
        where: {
          userId,
          status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
        },
      });

    const configured = hasApprovedIdentity && user.signatureId !== null;

    if (user.signingCredentialConfigured !== configured) {
      await this.userRepository.update(userId, {
        signingCredentialConfigured: configured,
      });
      this.logger.log(
        `signingCredentialConfigured de ${userId} pasó a ${configured}.`,
      );
    }

    await this.invalidateProfileCache(user.nationalId);

    return configured;
  }

  /**
   * `GET /api/v1/users/me` se sirve desde un snapshot en Redis cacheado por CURP. Sin invalidar
   * esa key, el usuario aprobaría su identidad y subiría su firma pero seguiría viendo
   * "Valida tu identidad" hasta que el cache se reconstruyera por otra vía.
   *
   * Se borra en lugar de reescribirse: `UserService.getMeFromCache` ya sabe rehidratar desde
   * Postgres cuando la key no existe, así que borrar evita duplicar aquí la forma del snapshot
   * (y evita que este módulo dependa de `UserModule`, que importa `SignatureModule`, que a su
   * vez importa este módulo).
   */
  private async invalidateProfileCache(nationalId: string): Promise<void> {
    try {
      await this.redisService.del(nationalId);
    } catch (error) {
      // Un fallo de Redis no puede tumbar la aprobación de una identidad ni el alta de una firma.
      this.logger.warn(
        `No se pudo invalidar el cache de perfil de ${nationalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
