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
 * - En un documento secuencial (`isSequential` distinto de `false`), los firmantes se ordenan por
 *   su `order` —que `IntegrationPayloadValidator` ya exigió único y consecutivo— y los testigos van
 *   después, en el orden del arreglo. El resultado viaja como `orderIndex` en TODOS los
 *   colaboradores, que es lo que el flujo necesita para respetarlo. En uno no secuencial se
 *   conserva el orden del arreglo.
 * - El nombre del documento es el del PDF recibido.
 * - El `rfc` de un firmante (sólo `ADVANCED`, ya validado) viaja como `signerTaxId`: es contra lo
 *   que se compara el titular de su certificado al firmar.
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

  const isSequential = document.isSequential !== false;
  const ordered = isSequential
    ? [
        ...participants
          .filter((p) => p.role === INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER)
          .sort((a, b) => a.order! - b.order!),
        ...participants.filter(
          (p) => p.role !== INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
        ),
      ]
    : participants;

  return {
    documentData: {
      fileName,
      signatureType: document.signatureType,
      isSequential: document.isSequential,
      requiresApproval: false,
      isIndexable: document.isIndexable,
    },
    collaborators: ordered.map((participant, position) => {
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
        orderIndex: isSequential ? position : undefined,
        signerTaxId: isSigner ? (participant.rfc ?? null) : undefined,
      };
    }),
  } as CreateDocumentSignaturesDto;
}
