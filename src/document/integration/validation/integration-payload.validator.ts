import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';

import { SignaturePositionDto } from '../../dto/create-document-signatures.dto';
import { findOverlappingSignaturePositions } from '../../utils/signature-collision.util';
import { findSignaturePositionOutsideDocument } from '../../utils/signature-position.util';
import {
  INTEGRATION_PARTICIPANT_ROLE_ENUM,
  IntegrationDocumentPayloadDto,
  IntegrationParticipantDto,
} from '../dto/create-integration-document.dto';
import {
  INTEGRATION_VALIDATION_CODE_ENUM as CODE,
  IntegrationValidationException,
} from './integration-validation.exception';

/** Máximo de colaboradores si `MAX_INTEGRATION_DOCUMENT_PARTICIPANTS` no está configurado. */
export const DEFAULT_MAX_INTEGRATION_DOCUMENT_PARTICIPANTS = 50;

/** Mensaje de cada código, para los errores que salen de los validadores de campo. */
const FIELD_MESSAGES: Partial<Record<CODE, string>> = {
  [CODE.INVALID_PAYLOAD]: 'El payload tiene un campo inválido.',
  [CODE.INVALID_CREATOR]:
    'El creador debe tener un correo válido, nombre y apellido.',
  [CODE.INVALID_DOCUMENT_OPTIONS]: 'Las opciones del documento no son válidas.',
  [CODE.INVALID_PARTICIPANT_ROLE]: `El rol del colaborador debe ser ${Object.values(INTEGRATION_PARTICIPANT_ROLE_ENUM).join(' o ')}.`,
  [CODE.INVALID_PARTICIPANT_NAME]:
    'El nombre y el apellido del colaborador son obligatorios.',
  [CODE.INVALID_PARTICIPANT_EMAIL]:
    'El correo del colaborador es obligatorio y debe ser válido.',
  [CODE.INVALID_SIGNING_ORDER]:
    'El orden de firma debe ser un número entero mayor o igual a 1.',
  [CODE.INVALID_SIGNATURE_POSITION]:
    'La posición de firma no es válida: la página debe ser un entero desde 1, los ratios deben estar entre 0 y 1, y el ancho y el alto deben ser mayores que 0.',
};

/** El código que se reporta por la propiedad raíz cuando el validador no trae uno propio. */
const ROOT_PROPERTY_CODES: Record<string, CODE> = {
  creator: CODE.INVALID_CREATOR,
  document: CODE.INVALID_DOCUMENT_OPTIONS,
};

/**
 * Validación del payload de creación de documentos por integración, con un error `422` de código
 * estable y campo exacto por cada regla (`IntegrationValidationException`).
 *
 * Corre en dos tiempos, los dos antes de subir el archivo a MinIO o reservar nada:
 * 1. `validatePayload`, sobre el JSON: estructura y tamaño de `participants`, cada campo (con los
 *    validadores del DTO, incluido `SignaturePositionDto` de la plataforma) y las reglas entre
 *    participantes.
 * 2. `assertPositionsFitDocument`, con las páginas del PDF ya leídas: que cada posición exista en
 *    el documento y quepa en su página, y que ninguna se traslape. Usa las mismas reglas que el flujo
 *    de la plataforma (`findSignaturePositionOutsideDocument`, `findOverlappingSignaturePositions`);
 *    el flujo las vuelve a aplicar como defensa en profundidad.
 *
 * Los límites salen de la configuración: `MAX_INTEGRATION_DOCUMENT_PARTICIPANTS` (50 por omisión)
 * y, opcionalmente, `MAX_INTEGRATION_SIGNATURE_POSITIONS_PER_SIGNER`.
 */
@Injectable()
export class IntegrationPayloadValidator {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Valida el `payload` crudo del multipart y lo devuelve como DTO.
   *
   * @param raw - El campo `payload` tal como llegó (texto JSON).
   * @returns El payload validado, con los correos normalizados.
   *
   * @throws {IntegrationValidationException} (422) Con el código de la primera regla que falle.
   *
   * @example
   * ```ts
   * const payload = validator.validatePayload(request.body.payload);
   * ```
   */
  validatePayload(raw: unknown): IntegrationDocumentPayloadDto {
    const plain = parsePayload(raw);
    this.assertParticipantsList(plain.participants);

    const payload = plainToInstance(IntegrationDocumentPayloadDto, plain);
    const [error] = validateSync(payload);
    if (error) {
      throw toValidationException(error);
    }

    this.assertParticipantRules(payload);
    return payload;
  }

  /**
   * Comprueba las posiciones de firma contra el PDF: página existente, caja dentro de la página y
   * sin traslapes entre ninguna de las posiciones del documento.
   *
   * @param payload - Payload ya validado.
   * @param totalPages - Páginas del PDF recibido.
   * @returns Nada.
   *
   * @throws {IntegrationValidationException} (422) `SIGNATURE_POSITION_PAGE_OUT_OF_RANGE`,
   *   `INVALID_SIGNATURE_POSITION` o `SIGNATURE_POSITION_OVERLAP`.
   *
   * @example
   * ```ts
   * validator.assertPositionsFitDocument(payload, await pdf.getPdfPages(file));
   * ```
   */
  assertPositionsFitDocument(
    payload: IntegrationDocumentPayloadDto,
    totalPages: number,
  ): void {
    const fieldByPosition = new Map<SignaturePositionDto, string>();
    const positionsByPage = new Map<number, SignaturePositionDto[]>();

    payload.participants.forEach((participant, participantIndex) => {
      const positions = participant.signaturePositions ?? [];
      const outside = findSignaturePositionOutsideDocument(
        positions,
        totalPages,
      );
      if (outside) {
        const field = `participants[${participantIndex}].signaturePositions[${outside.index}]`;
        throw outside.reason === 'PAGE_OUT_OF_RANGE'
          ? new IntegrationValidationException(
              CODE.SIGNATURE_POSITION_PAGE_OUT_OF_RANGE,
              `La posición de firma está en la página ${outside.position.page}, pero el documento sólo tiene ${totalPages}.`,
              {
                field: `${field}.page`,
                page: outside.position.page,
                totalPages,
              },
            )
          : new IntegrationValidationException(
              CODE.INVALID_SIGNATURE_POSITION,
              'La posición de firma se sale de los límites de la página.',
              {
                field,
                reason: 'OUT_OF_PAGE_BOUNDS',
                page: outside.position.page,
              },
            );
      }

      positions.forEach((position, positionIndex) => {
        fieldByPosition.set(
          position,
          `participants[${participantIndex}].signaturePositions[${positionIndex}]`,
        );
        positionsByPage.set(position.page, [
          ...(positionsByPage.get(position.page) ?? []),
          position,
        ]);
      });
    });

    const overlap = findOverlappingSignaturePositions(positionsByPage);
    if (overlap) {
      throw new IntegrationValidationException(
        CODE.SIGNATURE_POSITION_OVERLAP,
        'Las posiciones de firma no pueden traslaparse en la misma página.',
        {
          field: fieldByPosition.get(overlap[1]),
          fields: overlap.map((position) => fieldByPosition.get(position)),
          page: overlap[0].page,
        },
      );
    }
  }

  /** `participants`: obligatorio, arreglo no vacío y dentro del máximo configurado. */
  private assertParticipantsList(participants: unknown): void {
    if (!Array.isArray(participants) || participants.length === 0) {
      throw new IntegrationValidationException(
        CODE.PARTICIPANTS_REQUIRED,
        'El documento debe tener al menos un colaborador en `participants`.',
        { field: 'participants' },
      );
    }

    const limit = this.maxParticipants();
    if (participants.length > limit) {
      throw new IntegrationValidationException(
        CODE.MAX_PARTICIPANTS_EXCEEDED,
        `El documento admite como máximo ${limit} colaboradores.`,
        { field: 'participants', limit, received: participants.length },
      );
    }
  }

  /**
   * Reglas entre participantes: al menos un firmante, correos únicos, posiciones según el rol y,
   * en documentos secuenciales, un orden único y consecutivo entre firmantes.
   */
  private assertParticipantRules(payload: IntegrationDocumentPayloadDto): void {
    const { participants } = payload;
    const signers = participants
      .map((participant, index) => ({ participant, index }))
      .filter(
        ({ participant }) =>
          participant.role === INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
      );

    if (signers.length === 0) {
      throw new IntegrationValidationException(
        CODE.SIGNER_REQUIRED,
        'El documento debe tener al menos un colaborador con rol SIGNER.',
        { field: 'participants' },
      );
    }

    const firstIndexByEmail = new Map<string, number>();
    participants.forEach((participant, index) => {
      const previous = firstIndexByEmail.get(participant.email);
      if (previous !== undefined) {
        throw new IntegrationValidationException(
          CODE.DUPLICATE_PARTICIPANT_EMAIL,
          'Un colaborador sólo puede participar una vez en el documento.',
          {
            field: `participants[${index}].email`,
            email: participant.email,
            duplicateOf: `participants[${previous}].email`,
          },
        );
      }
      firstIndexByEmail.set(participant.email, index);

      this.assertPositionsForRole(participant, index);
    });

    if (payload.document.isSequential !== false) {
      assertSequentialOrder(signers);
    }
  }

  private assertPositionsForRole(
    participant: IntegrationParticipantDto,
    index: number,
  ): void {
    const field = `participants[${index}].signaturePositions`;
    const positions = participant.signaturePositions;

    if (participant.role === INTEGRATION_PARTICIPANT_ROLE_ENUM.WITNESS) {
      if (positions !== undefined && positions !== null) {
        throw new IntegrationValidationException(
          CODE.WITNESS_SIGNATURE_POSITION_NOT_ALLOWED,
          'Un testigo no firma: no debe incluir posiciones de firma.',
          { field },
        );
      }
      return;
    }

    if (!positions?.length) {
      throw new IntegrationValidationException(
        CODE.SIGNER_SIGNATURE_POSITION_REQUIRED,
        'Cada firmante debe incluir al menos una posición de firma.',
        { field },
      );
    }

    const limit = this.maxPositionsPerSigner();
    if (limit !== null && positions.length > limit) {
      throw new IntegrationValidationException(
        CODE.MAX_SIGNATURE_POSITIONS_EXCEEDED,
        `Cada firmante admite como máximo ${limit} posiciones de firma.`,
        { field, limit, received: positions.length },
      );
    }
  }

  private maxParticipants(): number {
    return (
      positiveInteger(
        this.configService.get('MAX_INTEGRATION_DOCUMENT_PARTICIPANTS'),
      ) ?? DEFAULT_MAX_INTEGRATION_DOCUMENT_PARTICIPANTS
    );
  }

  private maxPositionsPerSigner(): number | null {
    return positiveInteger(
      this.configService.get('MAX_INTEGRATION_SIGNATURE_POSITIONS_PER_SIGNER'),
    );
  }
}

/**
 * En un documento secuencial, cada firmante trae `order`, sin repetir, y los valores son
 * exactamente 1, 2, …, n.
 */
function assertSequentialOrder(
  signers: { participant: IntegrationParticipantDto; index: number }[],
): void {
  const indexByOrder = new Map<number, number>();

  for (const { participant, index } of signers) {
    const field = `participants[${index}].order`;
    if (participant.order === undefined || participant.order === null) {
      throw new IntegrationValidationException(
        CODE.INVALID_SIGNING_ORDER,
        'En un documento secuencial cada firmante debe indicar su `order`.',
        { field, reason: 'REQUIRED' },
      );
    }

    const previous = indexByOrder.get(participant.order);
    if (previous !== undefined) {
      throw new IntegrationValidationException(
        CODE.DUPLICATE_SIGNING_ORDER,
        'Dos firmantes no pueden tener el mismo orden de firma.',
        {
          field,
          order: participant.order,
          duplicateOf: `participants[${previous}].order`,
        },
      );
    }
    indexByOrder.set(participant.order, index);
  }

  const received = [...indexByOrder.keys()].sort((a, b) => a - b);
  const expected = received.map((_, position) => position + 1);
  if (received.some((order, position) => order !== expected[position])) {
    throw new IntegrationValidationException(
      CODE.INVALID_SIGNING_ORDER,
      `El orden de firma debe ser consecutivo desde 1 hasta ${expected.length}.`,
      { field: 'participants', reason: 'NOT_CONSECUTIVE', expected, received },
    );
  }
}

/** Lee el `payload` del multipart: texto JSON de un objeto. */
function parsePayload(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationValidationException(
      CODE.INVALID_PAYLOAD,
      'El campo `payload` es obligatorio y debe ser un objeto JSON.',
      { field: 'payload' },
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Convierte el primer error de class-validator en el error de integración: el código del
 * validador que falló (o el de su contenedor más cercano), el campo como `participants[2].email` y
 * el nombre de la regla incumplida. No devuelve el valor recibido: puede ser un dato personal.
 */
function toValidationException(
  error: ValidationError,
): IntegrationValidationException {
  const path: string[] = [];
  let inheritedCode: CODE | undefined;
  let current: ValidationError = error;

  for (;;) {
    path.push(current.property);
    inheritedCode = codeOf(current) ?? inheritedCode;
    if (current.constraints || !current.children?.length) break;
    current = current.children[0];
  }

  // Los errores anidados (cada caja de `signaturePositions`) no traen el `context` del contenedor.
  const code =
    inheritedCode ??
    (path.includes('signaturePositions')
      ? CODE.INVALID_SIGNATURE_POSITION
      : undefined) ??
    ROOT_PROPERTY_CODES[error.property] ??
    CODE.INVALID_PAYLOAD;
  const constraint = Object.keys(current.constraints ?? {})[0];

  return new IntegrationValidationException(
    code,
    FIELD_MESSAGES[code] ?? FIELD_MESSAGES[CODE.INVALID_PAYLOAD]!,
    {
      field: formatPath(path),
      ...(constraint && { reason: constraint }),
      ...(code === CODE.INVALID_PARTICIPANT_ROLE && {
        allowed: Object.values(INTEGRATION_PARTICIPANT_ROLE_ENUM),
      }),
    },
  );
}

function codeOf(error: ValidationError): CODE | undefined {
  const contexts = error.contexts ?? {};
  const constraint =
    Object.keys(error.constraints ?? {}).find((name) => contexts[name]) ??
    Object.keys(contexts)[0];
  return constraint ? (contexts[constraint]?.code as CODE) : undefined;
}

function formatPath(path: string[]): string {
  return path.reduce(
    (field, segment) =>
      /^\d+$/.test(segment)
        ? `${field}[${segment}]`
        : field
          ? `${field}.${segment}`
          : segment,
    '',
  );
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
