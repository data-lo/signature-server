import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { IdentityNotApprovedException } from '../exceptions/identity-verification.exceptions';

/**
 * Mensaje por estado del último intento. Lo consume `SignatureModule` cuando bloquea el alta de
 * la firma: decirle al usuario "no puedes subir tu firma" sin explicar que su verificación
 * sigue en revisión lo deja sin saber qué hacer.
 */
const REASON_BY_STATUS: Partial<
  Record<IDENTITY_VERIFICATION_STATUS_ENUM, string>
> = {
  [IDENTITY_VERIFICATION_STATUS_ENUM.PENDING]:
    'Tu verificación de identidad aún no ha comenzado. Complétala antes de registrar tu firma.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS]:
    'Tu verificación de identidad está en curso. Termínala en Didit antes de registrar tu firma.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW]:
    'Tu identidad está en revisión. Te avisaremos en cuanto tengamos el resultado.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED]:
    'No fue posible validar tu identidad. Inicia una nueva verificación para registrar tu firma.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED]:
    'Dejaste la verificación de identidad sin terminar. Inicia una nueva para registrar tu firma.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED]:
    'Tu verificación de identidad expiró. Inicia una nueva para registrar tu firma.',
  [IDENTITY_VERIFICATION_STATUS_ENUM.FAILED]:
    'Tu verificación de identidad no pudo completarse. Inicia una nueva para registrar tu firma.',
};

const NEVER_STARTED =
  'Necesitas validar tu identidad antes de registrar tu firma.';

/**
 * Guarda de dominio: lanza si el usuario no tiene una identidad aprobada.
 *
 * Es la puerta que `SignatureModule` cruza antes de aceptar la firma PNG. Se comprueba contra
 * la tabla `identity_verifications` y **no** contra `users.signing_credential_configured`: esa
 * bandera sólo es true cuando ya existe la firma, así que usarla acá sería circular — nadie
 * podría subir su primera firma nunca.
 */
@Injectable()
export class AssertIdentityApprovedUseCase {
  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
  ) {}

  async execute(userId: string): Promise<void> {
    const approved = await this.identityVerificationRepository.exists({
      where: { userId, status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED },
    });

    if (approved) {
      return;
    }

    /**
     * Se busca una aprobación en CUALQUIER intento, no sólo en el más reciente: si un usuario
     * aprobado arranca otra verificación por curiosidad y la abandona, su identidad no deja de
     * estar validada. Sólo cuando no existe ninguna aprobación se mira el último intento, y
     * únicamente para explicarle en qué va.
     */
    const latest = await this.identityVerificationRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    throw new IdentityNotApprovedException(
      latest
        ? (REASON_BY_STATUS[latest.status] ?? NEVER_STARTED)
        : NEVER_STARTED,
    );
  }
}
