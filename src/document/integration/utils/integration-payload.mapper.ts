import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_COLLABORATOR_SOURCE_ENUM,
} from '../../dto/create-document-signatures.dto';
import {
  INTEGRATION_PARTICIPANT_ROLE_ENUM,
  IntegrationDocumentPayloadDto,
} from '../dto/create-integration-document.dto';
import { IntegrationApprovalNotSupportedException } from '../exceptions/integration-document.exceptions';

/**
 * Traduce el `payload` de la API de integración al DTO de `CreateDocumentSignatureFlowUseCase`,
 * para que el documento pase exactamente por las mismas validaciones y el mismo alta que uno
 * creado desde la plataforma.
 *
 * - Cada participante es un colaborador `MANUAL` (invitado por correo), sin alta en el Directorio:
 *   el aprovisionamiento automático de cuentas es sólo para el creador.
 * - `order` (desde 1) se vuelve `orderIndex` (desde 0) sólo si TODOS los participantes lo traen,
 *   la misma regla que aplica el flujo; si no, se firma en el orden del arreglo.
 * - El nombre del documento es el del PDF recibido.
 *
 * @param payload - Payload ya validado.
 * @param fileName - Nombre del archivo PDF recibido.
 * @returns El DTO del flujo de creación.
 *
 * @throws {IntegrationApprovalNotSupportedException} (400) Si pide `requiresApproval: true`.
 *
 * @example
 * ```ts
 * const dto = toCreateDocumentSignaturesDto(payload, file.originalname);
 * await createDocumentSignatureFlow.execute(userId, accountId, dto, file, ip, origin);
 * ```
 */
export function toCreateDocumentSignaturesDto(
  payload: IntegrationDocumentPayloadDto,
  fileName: string,
): CreateDocumentSignaturesDto {
  const { document, participants } = payload;

  if (document.requiresApproval === true) {
    throw new IntegrationApprovalNotSupportedException();
  }

  const everyoneHasOrder = participants.every(
    (participant) => typeof participant.order === 'number',
  );

  return {
    documentData: {
      fileName,
      signatureType: document.signatureType,
      isSequential: document.isSequential,
      requiresApproval: false,
      isIndexable: document.isIndexable,
    },
    collaborators: participants.map((participant) => {
      const isSigner =
        participant.role === INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER;

      return {
        source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
        addToDirectory: false,
        collaboratorType: isSigner
          ? PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER
          : PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS,
        firstName: participant.firstName,
        lastName: participant.lastName,
        email: participant.email,
        signatures: isSigner ? participant.signaturePositions : undefined,
        requiresTwoFactorAuth: participant.requiresTwoFactorAuth,
        orderIndex: everyoneHasOrder ? participant.order! - 1 : undefined,
      };
    }),
  } as CreateDocumentSignaturesDto;
}
