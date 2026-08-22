import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { RedisService } from 'src/shared/redis/redis.service';
import { InvalidSigningCredentialTransitionException } from '../exceptions/identity-verification.exceptions';

const S = SIGNING_CREDENTIAL_STATUS_ENUM;

/**
 * La máquina de estados completa, en un solo lugar.
 *
 * Se declara qué transiciones son posibles en vez de dejar que cada caso de uso escriba el
 * estado que le parezca: así una regresión ("aprobado vuelve a pendiente") es imposible por
 * construcción y no depende de que cada llamador se acuerde de comprobarla.
 *
 * Notas sobre las aristas menos obvias:
 * - Desde SIGNATURE_PENDING y CONFIGURED se puede volver a RETRY_REQUIRED: si un intento
 *   aprobado expira o se revoca, la credencial tiene que dejar de valer por la misma vía por
 *   la que se otorgó.
 * - CONFIGURED → SIGNATURE_PENDING es el borrado de la firma PNG: la identidad sigue aprobada,
 *   lo que falta es el archivo.
 * - FAILED y MAX_ATTEMPTS_EXCEEDED son terminales para el usuario: sólo una intervención
 *   administrativa (fuera de este flujo) los saca de ahí.
 */
export const ALLOWED_SIGNING_CREDENTIAL_TRANSITIONS: Readonly<
  Record<
    SIGNING_CREDENTIAL_STATUS_ENUM,
    readonly SIGNING_CREDENTIAL_STATUS_ENUM[]
  >
> = {
  [S.IDENTITY_VERIFICATION_REQUIRED]: [
    S.IDENTITY_VERIFICATION_PENDING,
    S.IDENTITY_VERIFICATION_FAILED,
    S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ],
  [S.IDENTITY_VERIFICATION_PENDING]: [
    S.IDENTITY_VERIFICATION_IN_PROGRESS,
    S.IDENTITY_VERIFICATION_IN_REVIEW,
    S.SIGNATURE_PENDING,
    S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
    S.IDENTITY_VERIFICATION_FAILED,
    S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ],
  [S.IDENTITY_VERIFICATION_IN_PROGRESS]: [
    S.IDENTITY_VERIFICATION_IN_REVIEW,
    S.SIGNATURE_PENDING,
    S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
    S.IDENTITY_VERIFICATION_FAILED,
    S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ],
  [S.IDENTITY_VERIFICATION_IN_REVIEW]: [
    S.SIGNATURE_PENDING,
    S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
    S.IDENTITY_VERIFICATION_FAILED,
    S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ],
  [S.IDENTITY_VERIFICATION_RETRY_REQUIRED]: [
    S.IDENTITY_VERIFICATION_PENDING,
    S.IDENTITY_VERIFICATION_FAILED,
    S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ],
  [S.IDENTITY_VERIFICATION_FAILED]: [],
  [S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED]: [],
  [S.SIGNATURE_PENDING]: [
    S.CONFIGURED,
    S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
    S.IDENTITY_VERIFICATION_FAILED,
  ],
  [S.CONFIGURED]: [
    S.SIGNATURE_PENDING,
    S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
    S.IDENTITY_VERIFICATION_FAILED,
  ],
};

/**
 * Quedarse en el mismo estado siempre es válido: Didit reentrega webhooks y el usuario recarga
 * pantallas, así que la misma transición puede pedirse dos veces. Se resuelve como no-op, no
 * como error.
 */
export function canTransitionSigningCredentialStatus(
  from: SIGNING_CREDENTIAL_STATUS_ENUM,
  to: SIGNING_CREDENTIAL_STATUS_ENUM,
): boolean {
  return (
    from === to || ALLOWED_SIGNING_CREDENTIAL_TRANSITIONS[from].includes(to)
  );
}

/**
 * Único escritor de `users.signing_credential_status`.
 *
 * Todo lo que mueve el avance del usuario —webhook de Didit, alta o baja de la firma PNG,
 * regla de máximo de intentos— pasa por acá. Ningún servicio actualiza la columna por su
 * cuenta: si lo hiciera, la máquina de estados dejaría de ser verificable.
 */
@Injectable()
export class UpdateSigningCredentialStatusUseCase {
  private readonly logger = new Logger(
    UpdateSigningCredentialStatusUseCase.name,
  );

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Aplica la transición o falla. Es la variante para acciones de negocio, donde una transición
   * imposible significa que la operación no debía haberse permitido y el usuario tiene que
   * enterarse.
   *
   * @returns El estado resultante.
   */
  async execute(
    userId: string,
    target: SIGNING_CREDENTIAL_STATUS_ENUM,
  ): Promise<SIGNING_CREDENTIAL_STATUS_ENUM> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    if (
      !canTransitionSigningCredentialStatus(
        user.signingCredentialStatus,
        target,
      )
    ) {
      throw new InvalidSigningCredentialTransitionException(
        user.signingCredentialStatus,
        target,
      );
    }

    await this.persist(user, target);

    return target;
  }

  /**
   * Aplica la transición sólo si es posible; si no lo es, la registra y sigue.
   *
   * Es la variante para los disparadores que no pueden fallar hacia afuera: el webhook de Didit
   * (un 500 haría que el proveedor reintentara para siempre por un evento fuera de orden) y las
   * transiciones posteriores a una operación ya efectuada, como el borrado de la firma PNG —
   * el archivo ya no está, romper después no lo devuelve.
   *
   * @returns `true` si el estado quedó en `target`.
   */
  async applyIfAllowed(
    userId: string,
    target: SIGNING_CREDENTIAL_STATUS_ENUM,
  ): Promise<boolean> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      this.logger.warn(
        `No se pudo mover la credencial de firma a ${target}: el usuario ${userId} no existe.`,
      );
      return false;
    }

    if (
      !canTransitionSigningCredentialStatus(
        user.signingCredentialStatus,
        target,
      )
    ) {
      this.logger.warn(
        `Se ignora el paso de ${user.signingCredentialStatus} a ${target} para el usuario ${userId}: no es una transición válida.`,
      );
      return false;
    }

    await this.persist(user, target);

    return true;
  }

  private async persist(
    user: UserEntity,
    target: SIGNING_CREDENTIAL_STATUS_ENUM,
  ): Promise<void> {
    if (user.signingCredentialStatus === target) {
      return;
    }

    await this.userRepository.update(user.id, {
      signingCredentialStatus: target,
    });

    this.logger.log(
      `Credencial de firma de ${user.id}: ${user.signingCredentialStatus} → ${target}.`,
    );

    await this.invalidateProfileCache(user.nationalId);
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
