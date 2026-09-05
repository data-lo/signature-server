import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Falta una pieza SIN LA CUAL el XML de auditoría no describiría el documento: uno de los PDFs del
 * expediente, o una rúbrica cuya llave existe pero cuyo archivo no se pudo leer.
 *
 * Es un error controlado (422) y no un 500: la petición es válida, lo incompleto es la evidencia
 * guardada. Se prefiere fallar antes que entregar un expediente incompleto que después se presente
 * como completo.
 *
 * El mensaje nombra QUÉ falta y nunca datos personales: este texto termina en logs y en la respuesta
 * de una ruta pública, así que al firmante se le identifica por el id de su fila de colaborador.
 */
export class IncompleteAuditEvidenceException extends UnprocessableEntityException {
  constructor(missingEvidence: string, documentId: string) {
    super(
      `No se puede generar el XML de auditoría del documento ${documentId}: falta ${missingEvidence}.`,
    );
  }
}
