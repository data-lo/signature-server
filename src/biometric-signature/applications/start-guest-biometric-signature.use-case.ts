import { Injectable } from '@nestjs/common';

import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';

import { StartBiometricSignatureDto } from '../dto/start-biometric-signature.dto';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import { GuestAccessClaims } from '../guest/guest-access-token.service';
import { BiometricSignerService } from '../services/biometric-signer.service';
import { BiometricSessionLauncherService } from '../services/biometric-session-launcher.service';

/**
 * Inicia —o retoma— la firma biométrica de un invitado SIN cuenta: KYC de Didit (identificación +
 * prueba de vida + face match entre la identificación y la selfie viva), porque no hay identidad
 * previa contra la cual comparar.
 *
 * No crea `User` ni `Account`: la firma queda atada al colaborador y al correo de la invitación,
 * cuya posesión acreditó el invitado al validar el código (ver `GuestAccessGuard`).
 */
@Injectable()
export class StartGuestBiometricSignatureUseCase {
  constructor(
    private readonly signers: BiometricSignerService,
    private readonly launcher: BiometricSessionLauncherService,
  ) {}

  /**
   * Devuelve la sesión de Didit del invitado.
   *
   * @param documentId - Documento a firmar.
   * @param access - Lo que acreditó el token de invitado (colaborador y correo).
   * @param dto - Ubicación y consentimiento biométrico.
   * @param ipAddress - IP de la petición, evidencia de la firma.
   * @returns La sesión: URL de Didit, estado y si se reutilizó.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si la invitación ya no corresponde (p. ej. el
   *   colaborador vinculó una cuenta).
   * @throws {BadRequestException} Si el documento no admite la firma o ya respondió.
   * @throws {ForbiddenException} Si no es su turno.
   * @throws {DiditConfigurationException} Si falta `DIDIT_BIOMETRIC_GUEST_KYC_WORKFLOW_ID`.
   * @throws {DiditResponseException} Si Didit no pudo crear la sesión.
   *
   * @example
   * ```ts
   * await startGuest.execute('d-1', claims, { geolocation, biometricConsent: true }, '10.0.0.1');
   * ```
   */
  async execute(
    documentId: string,
    access: GuestAccessClaims,
    dto: StartBiometricSignatureDto,
    ipAddress: string | null,
  ): Promise<BiometricSignatureSession> {
    const resolved = await this.signers.resolveGuestSigner(
      documentId,
      access.collaboratorId,
      access.email,
    );
    // Sin código de firma aparte: el acceso del invitado YA es un código validado en su correo.
    await this.signers.assertCanStart(resolved, { requireSignCode: false });

    return this.launcher.launch({
      resolved,
      kind: 'GUEST',
      userId: null,
      identity: null,
      geolocation: dto.geolocation,
      ipAddress,
      // Sin correo ni colaborador en la URL: Didit la conoce, y el invitado retoma con su token.
      callbackUrl: `${frontendBaseUrl()}/public/documents/${documentId}/biometric-signature`,
    });
  }
}
