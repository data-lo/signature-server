import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Falta una pieza SIN LA CUAL el XML de auditoría no describiría el documento: uno de los PDFs del
 * expediente, o una rúbrica cuya llave existe pero cuyo archivo no se pudo leer.
 *
 * Es un error controlado (422) y no un 500: la petición es válida, lo que no está completo es la
 * evidencia guardada. Se prefiere fallar a entregar un expediente incompleto que después se
 * presente como completo — que es justo lo que un archivo de auditoría no puede permitirse.
 *
 * El mensaje nombra QUÉ falta, nunca datos personales de nadie: este texto termina en logs y en la
 * respuesta HTTP de una ruta pública. A un firmante se le identifica por el id de su fila de
 * colaborador, mismo criterio que `IncompleteSimpleSignatureDataException`.
 */
export class IncompleteAuditEvidenceException extends UnprocessableEntityException {
  constructor(missingEvidence: string, documentId: string) {
    super(
      `No se puede generar el XML de auditoría del documento ${documentId}: falta ${missingEvidence}.`,
    );
  }
}
