import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { MaxIdentityVerificationAttemptsExceededException } from '../exceptions/identity-verification.exceptions';
import { UpdateSigningCredentialStatusUseCase } from './update-signing-credential-status.use-case';

/**
 * Cada sesión de Didit se paga. El tope existe para que una cuenta comprometida —o un usuario
 * atascado— no consuma cuota sin límite, y para que un rechazo repetido escale a soporte en
 * vez de repetirse para siempre.
 */
export const MAX_IDENTITY_VERIFICATION_ATTEMPTS = 3;

/**
 * Intentos que cuentan contra el tope: los que terminaron sin identidad aprobada.
 *
 * Un intento PENDING o IN_PROGRESS no cuenta — todavía puede aprobarse, y se reutiliza en vez
 * de abrir otro. APPROVED tampoco: si el usuario ya está aprobado no llega hasta acá.
 */
const CONSUMED_STATUSES = [
  IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
  IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED,
  IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED,
  IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
];

/**
 * Decide si al usuario le quedan intentos de verificación antes de abrir una sesión nueva.
 *
 * Cuando el tope se agota, no se limita a rechazar: deja al usuario en
 * `IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED`, que es un estado terminal del que sólo lo saca
 * una intervención administrativa. Así el bloqueo queda visible en la pantalla y no depende de
 * recontar los intentos en cada lectura.
 */
@Injectable()
export class ValidateVerificationAttemptsUseCase {
  private readonly logger = new Logger(
    ValidateVerificationAttemptsUseCase.name,
  );

  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
  ) {}

  /**
   * @returns Intentos que todavía le quedan al usuario.
   * @throws MaxIdentityVerificationAttemptsExceededException si ya no le queda ninguno.
   */
  async execute(userId: string): Promise<number> {
    const consumed = await this.identityVerificationRepository.count({
      where: { userId, status: In(CONSUMED_STATUSES) },
    });

    if (consumed >= MAX_IDENTITY_VERIFICATION_ATTEMPTS) {
      this.logger.warn(
        `El usuario ${userId} agotó sus ${MAX_IDENTITY_VERIFICATION_ATTEMPTS} intentos de verificación.`,
      );

      await this.updateSigningCredentialStatus.applyIfAllowed(
        userId,
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      );

      throw new MaxIdentityVerificationAttemptsExceededException(
        MAX_IDENTITY_VERIFICATION_ATTEMPTS,
      );
    }

    return MAX_IDENTITY_VERIFICATION_ATTEMPTS - consumed;
  }
}
