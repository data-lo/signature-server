import { Injectable } from '@nestjs/common';

import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

/** Tipo de firma en el vocabulario del contrato público (el backend llama `FIEL` a `ADVANCED`). */
export type PublicSignatureType = 'SIMPLE' | 'ADVANCED' | 'BIOMETRIC';

/** Tipo del colaborador → tipo del contrato público. */
export const PUBLIC_SIGNATURE_TYPE: Record<
  SIGNATURE_TYPE_ENUM,
  PublicSignatureType
> = {
  [SIGNATURE_TYPE_ENUM.SIMPLE]: 'SIMPLE',
  [SIGNATURE_TYPE_ENUM.FIEL]: 'ADVANCED',
  [SIGNATURE_TYPE_ENUM.BIOMETRIC]: 'BIOMETRIC',
};

/** Qué exige la firma de un colaborador. Lo resuelve el backend; el cliente no decide nada. */
export interface SigningRequirements {
  type: PublicSignatureType;
  /** Código al correo de la invitación antes de la sesión. */
  requiresEmailVerification: boolean;
  /** Verificación de identidad antes de firmar (simple: Didit; biométrica: la propia sesión). */
  requiresIdentityValidation: boolean;
  identityProvider: 'DIDIT' | null;
  /**
   * Si una verificación de identidad aprobada antes se puede reutilizar, y por cuánto tiempo
   * (`null`: sin vencimiento).
   */
  identityValidationReuse: { allowed: boolean; maxAgeDays: number | null };
  /** Validación del certificado y de la firma criptográfica (avanzada). */
  requiresCertificateValidation: boolean;
  certificateRequirements: {
    validateValidity: boolean;
    validateRevocation: boolean;
    validateSubjectMatch: boolean;
  } | null;
}

/**
 * Política de firma de un colaborador: a partir del documento, el colaborador (su tipo de firma) y
 * la organización, decide qué validaciones exige la firma.
 *
 * Hoy no hay políticas configurables por organización, así que toda organización recibe los
 * valores por omisión de abajo. Es el único lugar que los decide: el día que exista una
 * configuración, se lee aquí y nada más cambia.
 *
 * - **SIMPLE**: código al correo + identidad con Didit (reutilizable mientras esté aprobada).
 * - **ADVANCED** (`FIEL`): código al correo + certificado (vigencia, revocación y titular) y firma
 *   criptográfica; Didit no.
 * - **BIOMETRIC**: código al correo + la sesión biométrica de Didit (que ya es la identidad).
 */
@Injectable()
export class SigningPolicyResolver {
  /**
   * Requisitos de la firma de un colaborador.
   *
   * @param document - Documento (su organización, cuando haya políticas).
   * @param collaborator - Firmante, con su tipo de firma.
   * @returns Los requisitos.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * policy.resolve(document, collaborator).requiresIdentityValidation; // true para SIMPLE
   * ```
   */
  resolve(
    document: DocumentEntity,
    collaborator: CollaboratorEntity,
  ): SigningRequirements {
    void document; // La organización elegirá la política cuando sea configurable.
    const type =
      PUBLIC_SIGNATURE_TYPE[
        collaborator.signatureType ?? SIGNATURE_TYPE_ENUM.SIMPLE
      ];

    return {
      type,
      requiresEmailVerification: true,
      requiresIdentityValidation: type !== 'ADVANCED',
      identityProvider: type === 'ADVANCED' ? null : 'DIDIT',
      identityValidationReuse: { allowed: true, maxAgeDays: null },
      requiresCertificateValidation: type === 'ADVANCED',
      certificateRequirements:
        type === 'ADVANCED'
          ? {
              validateValidity: true,
              validateRevocation: true,
              validateSubjectMatch: true,
            }
          : null,
    };
  }
}
