import { Module } from '@nestjs/common';
import { EfirmaService } from './efirma.service';
import { CertificateValidationApiService } from './certificate-validation/certificate-validation-api.service';

/**
 * Sin `EfirmaController`: `EfirmaService` se consume únicamente de forma interna (inyectado en
 * `DocumentModule`, ver historia "Integrar carga y validación de e.firma en el flujo de firma
 * avanzada") — no se expone como endpoint independiente. Antes existía `POST /efirma/sign` con
 * `@SkipJwtAuth()` (sin autenticación) desconectado del resto de la app; se eliminó por completo
 * en vez de solo deshabilitarlo.
 */
@Module({
  providers: [EfirmaService, CertificateValidationApiService],
  /**
   * `CertificateValidationApiService` se exporta para el reintento del sellado pendiente
   * (`RetryPendingSealUseCase`): cuando el SAT no respondió al firmar, la evidencia de revocación
   * se completa después, y para eso hay que poder validar el certificado sin volver a pasar por el
   * flujo de firma. Sustituye al `OscpService` que se exportaba antes de migrar la validación a
   * Certificate Validation Service.
   */
  exports: [EfirmaService, CertificateValidationApiService],
})
export class EfirmaModule {}
