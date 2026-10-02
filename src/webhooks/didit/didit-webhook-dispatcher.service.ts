import { Injectable, Logger } from '@nestjs/common';
import { ProcessDiditVerificationResultUseCase } from 'src/identity-verification/applications/process-didit-verification-result.use-case';
import { ProcessBiometricSignatureResultUseCase } from 'src/biometric-signature/applications/process-biometric-signature-result.use-case';
import { BiometricSignatureAttemptService } from 'src/biometric-signature/services/biometric-signature-attempt.service';
import { BIOMETRIC_SIGNATURE_VENDOR_DATA_PREFIX } from 'src/biometric-signature/didit/biometric-signature-didit.service';
import { DiditWebhookPayload } from './didit-webhook-payload.schema';

/** A qué dominio se entregó una entrega de Didit. */
export type DiditWebhookRoute =
  | 'biometric-signature'
  | 'identity-verification'
  | 'ignored';

/**
 * Decide a qué dominio pertenece una entrega de Didit, que manda al mismo endpoint los resultados
 * de la verificación de identidad y los de la firma biométrica.
 *
 * | Sesión | Destino |
 * |---|---|
 * | `session_id` de un intento de `biometric_signature_attempts` | `ProcessBiometricSignatureResultUseCase` |
 * | Cualquier otra | `ProcessDiditVerificationResultUseCase` |
 *
 * La llave es el `session_id`, no el `vendor_data`: el `vendor_data` lo eligió quien creó la sesión,
 * y la sesión la registró este servidor. Pero una entrega con el prefijo biométrico cuya sesión no
 * existe aquí se IGNORA en vez de mandarse a identidad: así una sesión de firma nunca puede mover la
 * credencial del onboarding.
 *
 * No interpreta resultados: eso es de cada dominio.
 */
@Injectable()
export class DiditWebhookDispatcherService {
  private readonly logger = new Logger(DiditWebhookDispatcherService.name);

  constructor(
    private readonly attempts: BiometricSignatureAttemptService,
    private readonly processBiometricSignatureResult: ProcessBiometricSignatureResultUseCase,
    private readonly processDiditVerificationResult: ProcessDiditVerificationResultUseCase,
  ) {}

  /**
   * Entrega el payload al procesador del dominio dueño de la sesión.
   *
   * @param payload - Cuerpo ya autenticado (HMAC) y validado.
   * @returns A qué dominio se entregó, o `ignored`.
   *
   * @throws {Error} Lo que lance el procesador de dominio, para que la entrega quede en FAILED y
   *   Didit la reintente.
   *
   * @example
   * ```ts
   * const route = await dispatcher.dispatch(payload); // 'biometric-signature'
   * ```
   */
  async dispatch(payload: DiditWebhookPayload): Promise<DiditWebhookRoute> {
    const attempt = await this.attempts.findBySession(payload.session_id);

    if (attempt) {
      await this.processBiometricSignatureResult.execute(attempt, payload);
      return 'biometric-signature';
    }

    if (
      payload.vendor_data.startsWith(BIOMETRIC_SIGNATURE_VENDOR_DATA_PREFIX)
    ) {
      this.logger.warn(
        `Webhook de Didit con vendor_data de firma biométrica para la sesión ${payload.session_id}, que no corresponde a ningún intento local: se ignora.`,
      );
      return 'ignored';
    }

    await this.processDiditVerificationResult.execute(payload);
    return 'identity-verification';
  }
}
