import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { X509Certificate } from 'node:crypto';

import { EfirmaService } from 'src/efirma/efirma.service';
import { OscpService } from 'src/efirma/oscp/oscp.service';
import { OCSPEvidence } from 'src/efirma/interfaces/OCSPEvidence.interface';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { IncompleteAdvancedSignatureEvidenceException } from '../exceptions/seal.exceptions';

/**
 * Completa la evidencia OCSP que el SAT no devolvió al firmar, con el certificado público que quedó
 * guardado en cada firma avanzada. Es la fase `VERIFYING_OCSP` de
 * `ProcessDocumentSealingJobUseCase`.
 *
 * Ya no se llama desde la vista pública ni limpia `documents.sealing_pending_at`: la marca la
 * limpia el procesador al cerrar el trabajo, cuando el PDF final ya muestra la constancia. Un
 * reintento que completa el OCSP pero falla después no deja el documento como si estuviera sellado.
 *
 * **Los errores se propagan tipados**, para que el worker decida:
 * - `OCSPNotAvailableException`: el SAT no respondió; se reintenta.
 * - `CertificadoRevocadoException`: el certificado está revocado; el documento no se sella.
 * - `OCSPInvalidResponseException`, `CadenaConfianzaInvalidaException` o
 *   `IncompleteAdvancedSignatureEvidenceException`: la evidencia no sirve; requiere revisión.
 *
 * Un resultado `unknown` NO es un error aquí: se guarda tal cual, como cualquier evidencia, y es el
 * procesador quien decide que no basta para sellar (ver `assertSealableOcspEvidence`).
 *
 * **Sobre `verifiedAt`.** Es el momento de la consulta de este reintento, no el de la firma, que
 * sigue en `advancedSignature.signedAt`. La consulta acredita que el certificado no está revocado
 * AHORA; como una revocación no se deshace, un certificado vigente hoy también lo estaba al firmar.
 * Queda registrado en el propio `verifiedAt`, no se disimula.
 */
@Injectable()
export class RetryPendingSealUseCase {
  private readonly logger = new Logger(RetryPendingSealUseCase.name);

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly efirmaService: EfirmaService,
    private readonly ocspService: OscpService,
  ) {}

  /**
   * Consulta el OCSP de cada firmante FIEL que no tiene evidencia, guarda cada respuesta en cuanto
   * llega y devuelve los firmantes releídos de la base.
   *
   * Los firmantes se procesan uno por uno, en orden de firma: si el tercero falla, la evidencia de
   * los dos primeros ya está guardada y el siguiente intento sólo pregunta por los que faltan.
   *
   * @param documentId - Documento de firma avanzada.
   * @returns Los firmantes (sólo rol `SIGNER`) con su evidencia actual, recargados de la base.
   *
   * @throws {OCSPNotAvailableException} Si el SAT no responde.
   * @throws {CertificadoRevocadoException} Si un certificado está revocado.
   * @throws {OCSPInvalidResponseException} Si la respuesta del SAT no sirve como evidencia.
   * @throws {CadenaConfianzaInvalidaException} Si el certificado guardado no encadena al SAT.
   * @throws {IncompleteAdvancedSignatureEvidenceException} Si el certificado guardado no se puede leer.
   *
   * @example
   * ```ts
   * const signers = await retryPendingSeal.execute(job.documentId);
   * ```
   */
  async execute(documentId: string): Promise<CollaboratorEntity[]> {
    const signers = await this.findSigners(documentId);

    const missing = signers.filter(
      (collaborator) =>
        collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
        collaborator.advancedSignature &&
        !collaborator.advancedSignature.ocspEvidence,
    );

    if (missing.length === 0) {
      return signers;
    }

    for (const collaborator of missing) {
      const ocspEvidence = await this.obtainOcspEvidence(collaborator);

      // `jsonb` se reescribe entero: el `update` reemplaza la columna, no la mezcla.
      await this.collaboratorRepository.update(collaborator.id, {
        advancedSignature: {
          ...collaborator.advancedSignature,
          ocspEvidence,
        },
      });

      this.logger.log(
        `Evidencia OCSP (${ocspEvidence.status}) guardada para el firmante ${collaborator.id} del documento ${documentId}.`,
      );
    }

    // Se relee para que quien selle use exactamente lo que quedó persistido.
    return this.findSigners(documentId);
  }

  /**
   * Firmantes del documento, sin testigos ni revisores, en orden de firma.
   *
   * @param documentId - Documento.
   * @returns Los colaboradores con rol `SIGNER`.
   *
   * @example
   * ```ts
   * const signers = await this.findSigners(documentId);
   * ```
   */
  private findSigners(documentId: string): Promise<CollaboratorEntity[]> {
    return this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      order: { signingOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Vuelve a consultar el estado de revocación con el certificado que quedó guardado en la firma.
   *
   * El PEM se persiste íntegro en `advancedSignature.certificate`, así que el firmante no vuelve a
   * subir su e.firma: la consulta sólo necesita el certificado público, nunca la llave privada.
   *
   * @param collaborator - Firmante FIEL con `advancedSignature`.
   * @returns La evidencia de la consulta.
   *
   * @throws {IncompleteAdvancedSignatureEvidenceException} Si el PEM guardado no se puede leer.
   * @throws {CadenaConfianzaInvalidaException} Si no encadena al SAT.
   * @throws {OCSPNotAvailableException | CertificadoRevocadoException | OCSPInvalidResponseException}
   *   Según responda el SAT.
   *
   * @example
   * ```ts
   * const evidence = await this.obtainOcspEvidence(collaborator);
   * ```
   */
  private async obtainOcspEvidence(
    collaborator: CollaboratorEntity,
  ): Promise<OCSPEvidence> {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(
        collaborator.advancedSignature.certificate.certificatePem,
      );
    } catch {
      throw new IncompleteAdvancedSignatureEvidenceException(
        'un certificado legible',
        collaborator.id,
      );
    }

    const cerBuffer = Buffer.from(certificate.raw);
    const issuer = this.efirmaService.validarCadenaConfianza(cerBuffer);

    return this.ocspService.verifyRevokedOCSP(cerBuffer, issuer);
  }
}
