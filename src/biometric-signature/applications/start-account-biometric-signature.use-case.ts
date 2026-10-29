import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from 'src/identity-verification/enums/identity-verification-status.enum';

import { StartBiometricSignatureDto } from '../dto/start-biometric-signature.dto';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import { BiometricIdentityNotVerifiedException } from '../biometric-signature.exceptions';
import { BiometricSignerService } from '../services/biometric-signer.service';
import { BiometricSessionLauncherService } from '../services/biometric-session-launcher.service';

/**
 * Inicia —o retoma— la firma biométrica de un firmante CON cuenta: Biometric Authentication de
 * Didit (prueba de vida + face match) contra el retrato de su identidad ya aprobada.
 *
 * Sólo corre cuando el firmante pulsa "Firmar con biometría". Elegir `BIOMETRIC` al crear el
 * documento no abre nada. Esta llamada no firma: la firma se registra cuando el webhook trae la
 * aprobación.
 */
@Injectable()
export class StartAccountBiometricSignatureUseCase {
  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityRepository: Repository<IdentityVerificationEntity>,
    private readonly signers: BiometricSignerService,
    private readonly launcher: BiometricSessionLauncherService,
  ) {}

  /**
   * Devuelve la sesión de Didit del firmante autenticado.
   *
   * @param documentId - Documento a firmar.
   * @param userId - Usuario autenticado (`sub` del JWT).
   * @param dto - Ubicación y consentimiento biométrico.
   * @param authorization - Contexto de `PermissionsGuard` para `DOCUMENT + SIGN`.
   * @param ipAddress - IP de la petición, evidencia de la firma.
   * @returns La sesión: URL de Didit, estado y si se reutilizó.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {ForbiddenException} Si no es firmante, no tiene `DOCUMENT.SIGN_SELF` o no es su turno.
   * @throws {BadRequestException} Si el documento no admite la firma, ya respondió, su firma no es
   *   biométrica o falta el código de verificación.
   * @throws {BiometricIdentityNotVerifiedException} Si no tiene identidad Didit aprobada.
   * @throws {BiometricReferencePortraitUnavailableException} Si su identidad no tiene retrato usable.
   * @throws {DiditConfigurationException} Si falta `DIDIT_BIOMETRIC_AUTH_WORKFLOW_ID`.
   * @throws {DiditResponseException} Si Didit no pudo crear la sesión.
   *
   * @example
   * ```ts
   * await startAccount.execute('d-1', 'u-1', { geolocation, biometricConsent: true }, auth, '10.0.0.1');
   * ```
   */
  async execute(
    documentId: string,
    userId: string,
    dto: StartBiometricSignatureDto,
    authorization: AuthorizationContext,
    ipAddress: string | null,
  ): Promise<BiometricSignatureSession> {
    const resolved = await this.signers.resolveAccountSigner(
      documentId,
      userId,
      authorization,
    );
    await this.signers.assertCanStart(resolved, { requireSignCode: true });

    const identity = await this.identityRepository.findOne({
      where: {
        userId,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
        providerSessionId: Not(IsNull()),
      },
      order: { createdAt: 'DESC' },
    });
    if (!identity) {
      throw new BiometricIdentityNotVerifiedException();
    }

    return this.launcher.launch({
      resolved,
      kind: 'ACCOUNT',
      userId,
      identity: {
        id: identity.id,
        providerSessionId: identity.providerSessionId,
      },
      geolocation: dto.geolocation,
      ipAddress,
      callbackUrl: `${frontendBaseUrl()}/dashboard/documents/${documentId}`,
    });
  }
}
