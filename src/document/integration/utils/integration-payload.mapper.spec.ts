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
    const [signer, witness] = toCreateDocumentSignaturesDto(
      payload(),
      'contrato.pdf',
    ).collaborators;

    expect(signer).toMatchObject({
      source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL,
      addToDirectory: false,
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
      email: 'luis@correo.com',
      signatures: [POSITION],
      orderIndex: 1,
    });
    // El testigo no firma: sus posiciones, si las manda, no se trasladan.
    expect(witness).toMatchObject({
      collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS,
      signatures: undefined,
      orderIndex: 0,
    });
  });

  it('si algún participante no trae order, conserva el orden del arreglo', () => {
    const base = payload();
    delete base.participants[1].order;

    const collaborators = toCreateDocumentSignaturesDto(
      base,
      'contrato.pdf',
    ).collaborators;

    expect(collaborators.map((c) => c.orderIndex)).toEqual([
      undefined,
      undefined,
    ]);
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
