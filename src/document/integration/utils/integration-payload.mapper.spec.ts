import {
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_COLLABORATOR_SOURCE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
} from '../../dto/create-document-signatures.dto';
import {
  INTEGRATION_PARTICIPANT_ROLE_ENUM,
  IntegrationDocumentPayloadDto,
} from '../dto/create-integration-document.dto';
import { IntegrationApprovalNotSupportedException } from '../exceptions/integration-document.exceptions';
import { toCreateDocumentSignaturesDto } from './integration-payload.mapper';

const POSITION = {
  page: 1,
  xRatio: 0.65,
  yRatio: 0.8,
  widthRatio: 0.18,
  heightRatio: 0.06,
};

function payload(
  overrides: Partial<IntegrationDocumentPayloadDto> = {},
): IntegrationDocumentPayloadDto {
  return {
    creator: { email: 'ana@cliente.com', firstName: 'Ana', lastName: 'López' },
    document: {
      signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
      isSequential: true,
      requiresApproval: false,
      isIndexable: true,
    },
    participants: [
      {
        role: INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
        firstName: 'Luis',
        lastName: 'Martínez',
        email: 'luis@correo.com',
        order: 2,
        signaturePositions: [POSITION],
      },
      {
        role: INTEGRATION_PARTICIPANT_ROLE_ENUM.WITNESS,
        firstName: 'Eva',
        lastName: 'Ruiz',
        email: 'eva@correo.com',
        order: 1,
        signaturePositions: [POSITION],
      },
    ],
    ...overrides,
  };
}

function signer(email: string, order?: number) {
  return {
    role: INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
    firstName: 'Firmante',
    lastName: 'Prueba',
    email,
    order,
    signaturePositions: [POSITION],
  };
}

describe('toCreateDocumentSignaturesDto', () => {
  it('arma el documento con el nombre del PDF y las opciones del payload', () => {
    const dto = toCreateDocumentSignaturesDto(payload(), 'contrato.pdf');

    expect(dto.documentData).toEqual({
      fileName: 'contrato.pdf',
      signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
      isSequential: true,
      requiresApproval: false,
      isIndexable: true,
    });
  });

  it('invita a cada participante como colaborador MANUAL por correo, sin Directorio', () => {
    const [witness] = toCreateDocumentSignaturesDto(
      payload({
        participants: [
          {
            role: INTEGRATION_PARTICIPANT_ROLE_ENUM.WITNESS,
            firstName: 'Eva',
            lastName: 'Ruiz',
            email: 'eva@correo.com',
          },
          {
            role: INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
            firstName: 'Luis',
            lastName: 'Martínez',
            email: 'luis@correo.com',
            order: 1,
            signaturePositions: [POSITION],
          },
        ],
      }),
      'contrato.pdf',
    ).collaborators.slice(1);

    expect(witness).toMatchObject({
      source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
      addToDirectory: false,
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS,
      email: 'eva@correo.com',
      signatures: undefined,
    });
  });

  it('en un documento secuencial ordena a los firmantes por order y deja a los testigos al final', () => {
    const collaborators = toCreateDocumentSignaturesDto(
      payload({
        participants: [
          signer('b@correo.com', 2),
          {
            role: INTEGRATION_PARTICIPANT_ROLE_ENUM.WITNESS,
            firstName: 'Eva',
            lastName: 'Ruiz',
            email: 'eva@correo.com',
          },
          signer('a@correo.com', 1),
        ],
      }),
      'contrato.pdf',
    ).collaborators;

    expect(collaborators.map((c) => [c.email, c.orderIndex])).toEqual([
      ['a@correo.com', 0],
      ['b@correo.com', 1],
      ['eva@correo.com', 2],
    ]);
  });

  it('en un documento no secuencial conserva el orden del arreglo y no manda orderIndex', () => {
    const collaborators = toCreateDocumentSignaturesDto(
      payload({
        document: {
          signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
          isSequential: false,
        },
        participants: [signer('b@correo.com', 2), signer('a@correo.com')],
      }),
      'contrato.pdf',
    ).collaborators;

    expect(collaborators.map((c) => [c.email, c.orderIndex])).toEqual([
      ['b@correo.com', undefined],
      ['a@correo.com', undefined],
    ]);
  });

  it('lleva el rfc de un firmante avanzado como signerTaxId', () => {
    const base = payload();
    const [luis, eva] = toCreateDocumentSignaturesDto(
      payload({
        document: {
          ...base.document,
          signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
        },
        participants: [
          { ...base.participants[0], rfc: 'LOPA800101AB1' },
          base.participants[1],
        ],
      }),
      'contrato.pdf',
    ).collaborators;

    expect(luis.signerTaxId).toBe('LOPA800101AB1');
    expect(eva.signerTaxId).toBeUndefined();
  });

  it('rechaza requiresApproval: true, que la integración todavía no admite', () => {
    expect(() =>
      toCreateDocumentSignaturesDto(
        payload({
          document: {
            signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE,
            requiresApproval: true,
          },
        }),
        'contrato.pdf',
      ),
    ).toThrow(IntegrationApprovalNotSupportedException);
  });
});
