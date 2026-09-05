import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { X509Certificate } from 'node:crypto';

import { EfirmaService } from 'src/efirma/efirma.service';
import { OscpService } from 'src/efirma/oscp/oscp.service';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';

/**
 * Retoma el sellado de un documento que quedó pendiente porque el SAT no respondió al firmar.
 *
 * **El reintento es perezoso**: no hay planificador en el proyecto, y añadirlo sería una pieza en
 * movimiento nueva para un caso que se resuelve solo en cuanto alguien vuelve a mirar el documento.
 * Es el mismo criterio con el que se reintenta la extracción del certificado TSA y con el que vencen
 * las sesiones de captura. La contrapartida, explícita: un documento que nadie abre no se sella.
 *
 * **El `verifiedAt` será el del reintento, no el del momento de firmar.** La comprobación acredita
 * que el certificado no está revocado AHORA y, como la revocación no se deshace, uno vigente hoy
 * también lo estaba al firmar, que es lo que la evidencia necesita sostener. Queda registrado en el
 * propio `verifiedAt`, no se disimula.
 */
@Injectable()
export class RetryPendingSealUseCase {
  private readonly logger = new Logger(RetryPendingSealUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly efirmaService: EfirmaService,
    private readonly ocspService: OscpService,
  ) {}

  /**
   * Intenta completar la evidencia que falta y devuelve si el documento quedó listo para sellar.
   *
   * NO sella por sí mismo: rellena las evidencias y limpia la marca para que el llamador —que tiene
   * el contexto del documento— dispare el sellado por su camino de siempre, sin duplicar acá la
   * orquestación de `sealAdvancedSignatures`.
   *
   * Nunca lanza: se invoca desde lecturas, y un fallo del SAT no puede tumbar esas pantallas.
   */
  async execute(document: DocumentEntity): Promise<boolean> {
    if (!document.sealingPendingAt) {
      return false;
    }

    const signers = await this.collaboratorRepository.find({
      where: { documentId: document.id },
    });

    const faltantes = signers.filter(
      (collaborator) =>
        collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
        collaborator.advancedSignature &&
        !collaborator.advancedSignature.ocspEvidence,
    );

    if (faltantes.length === 0) {
      // Ya no falta nada: la marca quedó obsoleta (otro reintento se adelantó, o se completó por
      // otra vía). Limpiarla evita reintentar en cada lectura para siempre.
      await this.clearPending(document);
      return true;
    }

    for (const collaborator of faltantes) {
      const evidencia = await this.obtainOcspEvidence(collaborator);

      if (!evidencia) {
        this.logger.warn(
          `El documento ${document.id} sigue pendiente de sellar: el SAT no respondió por el firmante ${collaborator.id}.`,
        );
        return false;
      }

      collaborator.advancedSignature = {
        ...collaborator.advancedSignature,
        ocspEvidence: evidencia,
      };

      await this.collaboratorRepository.update(collaborator.id, {
        advancedSignature: collaborator.advancedSignature,
      });
    }

    await this.clearPending(document);
    this.logger.log(
      `Evidencia OCSP completada para el documento ${document.id}: ya puede sellarse.`,
    );

    return true;
  }

  /**
   * Vuelve a consultar el estado de revocación con el certificado que quedó guardado en la firma.
   *
   * El PEM se persiste íntegro en `advancedSignature.certificate`, así que no hace falta que el
   * firmante vuelva a subir su e.firma: la comprobación de revocación sólo necesita el
   * certificado público, nunca la llave privada.
   */
  private async obtainOcspEvidence(collaborator: CollaboratorEntity) {
    try {
      const certificado = new X509Certificate(
        collaborator.advancedSignature.certificate.certificatePem,
      );
      const cerBuffer = Buffer.from(certificado.raw);
      const emisor = this.efirmaService.validarCadenaConfianza(cerBuffer);

      return await this.ocspService.verifyRevokedOCSP(cerBuffer, emisor);
    } catch (error) {
      /**
       * Se traga cualquier error, no sólo la indisponibilidad del SAT: un certificado revocado o
       * una cadena de confianza rota tampoco deben tumbar la pantalla desde la que se reintentó.
       * El documento se queda pendiente y el motivo queda en el log.
       */
      this.logger.warn(
        `No se pudo completar la evidencia OCSP del firmante ${collaborator.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async clearPending(document: DocumentEntity): Promise<void> {
    document.sealingPendingAt = null;
    await this.documentRepository.update(document.id, {
      sealingPendingAt: null,
    });
  }
}
