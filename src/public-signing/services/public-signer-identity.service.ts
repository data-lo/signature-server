import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { personNameMatches } from 'src/common/utils/person-name-match.util';
import {
  SIGNING_VALIDATION_ERROR_CODE_ENUM,
  SigningValidationException,
} from 'src/document/exceptions/signing-validation.exceptions';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from 'src/identity-verification/enums/identity-verification-status.enum';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

import { SigningRequirements } from './signing-policy.resolver';

/** Estado de la verificación de identidad del firmante, visto desde la firma pública. */
export type PublicIdentityStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

/** Resultado de evaluar la identidad del firmante contra la política. */
export interface IdentityAssessment {
  status: PublicIdentityStatus;
  /** Intento evaluado (`identity_verifications.id`), si hay. */
  verificationId: string | null;
  /** Si los datos leídos por Didit corresponden al firmante; `null` si todavía no hay aprobación. */
  dataMatches: boolean | null;
  /** URL de Didit para retomar un intento abierto. */
  resumeUrl: string | null;
  /** La identidad cumple la política: se puede firmar. */
  satisfied: boolean;
  /** Por qué no se puede firmar, si no. */
  errorCode: SIGNING_VALIDATION_ERROR_CODE_ENUM | null;
}

/** Datos de la persona que Didit leyó de la identificación. */
export interface DiditIdentityData {
  fullName: string | null;
  /** CURP (`personal_number`) si la identificación la trae. */
  personalNumber: string | null;
}

/** Credenciales en las que la verificación quedó bloqueada (sólo soporte la reabre). */
const BLOCKED_CREDENTIALS: ReadonlySet<SIGNING_CREDENTIAL_STATUS_ENUM> =
  new Set([
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_FAILED,
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
  ]);

/** Forma de una CURP. */
const CURP_FORMAT = /^[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z\d]\d$/;

/**
 * Lee de la decisión de Didit el nombre y la CURP de la identificación. Acepta la forma V3
 * (`id_verifications: [{…}]`) y la V2 (`id_verification: {…}`), igual que el resto de los mapeos.
 *
 * @param decision - Decisión guardada en `identity_verifications.decision`.
 * @returns Nombre completo y CURP, o `null` en lo que no venga.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * extractDiditIdentity({ id_verifications: [{ first_name: 'ANA', last_name: 'LOPEZ' }] }).fullName; // 'ANA LOPEZ'
 * ```
 */
export function extractDiditIdentity(
  decision: Record<string, unknown> | null,
): DiditIdentityData {
  const section =
    (Array.isArray(decision?.id_verifications)
      ? decision?.id_verifications[0]
      : null) ?? decision?.id_verification;
  const data =
    section && typeof section === 'object'
      ? (section as Record<string, unknown>)
      : {};
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  const parts = [text(data.first_name), text(data.last_name)].filter(Boolean);
  const fullName =
    text(data.full_name) ?? (parts.length > 0 ? parts.join(' ') : null);
  const personalNumber = text(data.personal_number)?.toUpperCase() ?? null;

  return {
    fullName,
    personalNumber:
      personalNumber && CURP_FORMAT.test(personalNumber)
        ? personalNumber
        : null,
  };
}

/**
 * Identidad del usuario provisional de un firmante simple: reutiliza la verificación de Didit del
 * onboarding (`identity_verifications` y `users.signing_credential_status`, que mueve el webhook)
 * y le agrega lo que la firma pública exige:
 *
 * - que esté aprobada (pendiente, en revisión, rechazada, vencida o fallida no sirven);
 * - que los datos leídos por Didit correspondan al firmante (nombre normalizado);
 * - que, si la política limita la reutilización, la aprobación siga vigente.
 */
@Injectable()
export class PublicSignerIdentityService {
  private readonly logger = new Logger(PublicSignerIdentityService.name);

  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly verificationRepository: Repository<IdentityVerificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  /**
   * Evalúa la identidad de un usuario contra la política.
   *
   * @param user - Usuario provisional del firmante.
   * @param expectedName - Nombre del firmante (colaborador).
   * @param requirements - Política de la firma.
   * @param now - Instante de referencia.
   * @returns El estado, el intento, si los datos corresponden y si se puede firmar.
   *
   * @throws Errores de la base.
   *
   * @example
   * ```ts
   * const assessment = await identity.assess(user, 'Ana López', requirements);
   * ```
   */
  async assess(
    user: UserEntity,
    expectedName: string,
    requirements: SigningRequirements,
    now: Date = new Date(),
  ): Promise<IdentityAssessment> {
    const latest = await this.verificationRepository.findOne({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    const base = {
      verificationId: latest?.id ?? null,
      dataMatches: null,
      resumeUrl: null,
    };

    if (BLOCKED_CREDENTIALS.has(user.signingCredentialStatus)) {
      return {
        ...base,
        status: 'REJECTED',
        satisfied: false,
        errorCode:
          SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REJECTED,
      };
    }
    if (!latest) {
      return {
        ...base,
        status: 'NOT_STARTED',
        satisfied: false,
        errorCode:
          SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REQUIRED,
      };
    }

    switch (latest.status) {
      case IDENTITY_VERIFICATION_STATUS_ENUM.PENDING:
      case IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS:
      case IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW: {
        const hostedUrl = latest.providerMetadata?.hostedUrl;
        return {
          ...base,
          status: latest.status as PublicIdentityStatus,
          resumeUrl: typeof hostedUrl === 'string' ? hostedUrl : null,
          satisfied: false,
          errorCode:
            SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REQUIRED,
        };
      }
      case IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED:
      case IDENTITY_VERIFICATION_STATUS_ENUM.FAILED:
        return {
          ...base,
          status: 'REJECTED',
          satisfied: false,
          errorCode:
            SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REJECTED,
        };
      case IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED:
      case IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED:
        // No validó la identidad, pero se puede volver a intentar.
        return {
          ...base,
          status: 'EXPIRED',
          satisfied: false,
          errorCode:
            SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REQUIRED,
        };
      default:
        break;
    }

    // Aprobada: vigencia según la política y correspondencia de datos.
    const { allowed, maxAgeDays } = requirements.identityValidationReuse;
    const approvedAt = latest.completedAt ?? latest.createdAt;
    const tooOld =
      !allowed ||
      (maxAgeDays !== null &&
        now.getTime() - approvedAt.getTime() > maxAgeDays * 86_400_000);
    const dataMatches = personNameMatches(
      expectedName,
      extractDiditIdentity(latest.decision).fullName,
    );

    let errorCode: SIGNING_VALIDATION_ERROR_CODE_ENUM | null = null;
    if (tooOld) {
      errorCode =
        SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_VERIFICATION_REQUIRED;
    } else if (!dataMatches) {
      errorCode = SIGNING_VALIDATION_ERROR_CODE_ENUM.IDENTITY_DATA_MISMATCH;
    }

    return {
      ...base,
      status: 'APPROVED',
      dataMatches,
      satisfied: errorCode === null,
      errorCode,
    };
  }

  /**
   * Exige que la identidad cumpla la política y, si Didit leyó la CURP y el usuario provisional no
   * tiene una, la guarda como evidencia (sólo si ningún otro usuario la tiene).
   *
   * @param user - Usuario provisional del firmante.
   * @param expectedName - Nombre del firmante.
   * @param requirements - Política de la firma.
   * @returns La evaluación (aprobada).
   *
   * @throws {SigningValidationException} `IDENTITY_VERIFICATION_REQUIRED`,
   *   `IDENTITY_VERIFICATION_REJECTED` o `IDENTITY_DATA_MISMATCH`.
   *
   * @example
   * ```ts
   * await identity.assertSatisfied(user, 'Ana López', requirements);
   * ```
   */
  async assertSatisfied(
    user: UserEntity,
    expectedName: string,
    requirements: SigningRequirements,
  ): Promise<IdentityAssessment> {
    const assessment = await this.assess(user, expectedName, requirements);
    if (!assessment.satisfied) {
      throw new SigningValidationException(
        assessment.errorCode!,
        IDENTITY_MESSAGES[assessment.errorCode!] ??
          'No se pudo confirmar tu identidad.',
      );
    }
    await this.recordVerifiedCurp(user, assessment.verificationId);
    return assessment;
  }

  private async recordVerifiedCurp(
    user: UserEntity,
    verificationId: string | null,
  ): Promise<void> {
    if (user.nationalId || !verificationId) return;
    const verification = await this.verificationRepository.findOne({
      where: { id: verificationId },
    });
    const curp = extractDiditIdentity(
      verification?.decision ?? null,
    ).personalNumber;
    if (!curp) return;

    const taken = await this.userRepository.exists({
      where: { nationalId: curp, id: Not(user.id) },
    });
    if (taken) {
      this.logger.warn(
        `La CURP leída por Didit para el usuario ${user.id} ya pertenece a otro usuario: no se guarda.`,
      );
      return;
    }
    await this.userRepository.update(
      { id: user.id, nationalId: IsNull() },
      { nationalId: curp },
    );
  }
}

/** Mensaje para el firmante de cada código de identidad. */
const IDENTITY_MESSAGES: Partial<
  Record<SIGNING_VALIDATION_ERROR_CODE_ENUM, string>
> = {
  IDENTITY_VERIFICATION_REQUIRED:
    'Antes de firmar tienes que completar la verificación de tu identidad.',
  IDENTITY_VERIFICATION_REJECTED:
    'No pudimos verificar tu identidad. Contacta a quien te envió el documento.',
  IDENTITY_DATA_MISMATCH:
    'La identificación verificada no corresponde a la persona invitada a firmar este documento.',
};
