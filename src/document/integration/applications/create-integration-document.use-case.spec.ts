import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { CreateDocumentSignatureFlowUseCase } from '../../applications/create-document-signature-flow.use-case';
import { PAYLOAD_SIGNATURE_TYPE_ENUM } from '../../dto/create-document-signatures.dto';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DocumentReadService } from '../../services/document-read.service';
import {
  INTEGRATION_PARTICIPANT_ROLE_ENUM,
  IntegrationDocumentPayloadDto,
} from '../dto/create-integration-document.dto';
import {
  IdempotencyKeyMismatchException,
  IntegrationApprovalNotSupportedException,
} from '../exceptions/integration-document.exceptions';
import { IntegrationCreatorService } from '../services/integration-creator.service';
import { IntegrationIdempotencyService } from '../services/integration-idempotency.service';
import { CreateIntegrationDocumentUseCase } from './create-integration-document.use-case';

const API_CLIENT: IntegrationApiClient = {
  apiKeyId: 'key-1',
  apiKeyName: 'Integración ERP',
  organizationId: 'org-1',
  actorAccountId: 'account-actor',
  actorUserId: 'user-actor',
  permissions: [],
};

const PAYLOAD: IntegrationDocumentPayloadDto = {
  creator: { email: 'Ana@Cliente.com', firstName: 'Ana', lastName: 'López' },
  document: { signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE },
  participants: [
    {
      role: INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER,
      firstName: 'Luis',
      lastName: 'Martínez',
      email: 'luis@correo.com',
      signaturePositions: [
        {
          page: 1,
          xRatio: 0.1,
          yRatio: 0.1,
          widthRatio: 0.2,
          heightRatio: 0.06,
        },
      ],
    },
  ],
};

const FILE = {
  originalname: 'contrato.pdf',
  mimetype: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7'),
} as Express.Multer.File;

const CREATED = {
  id: 'doc-1',
  fileName: 'contrato.pdf',
  status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
  signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
  createdAt: new Date('2026-10-27T12:00:00.000Z'),
  signedAt: null,
  creatorEmail: 'ana@cliente.com',
  participantsCount: 1,
};

describe('CreateIntegrationDocumentUseCase', () => {
  const originalPublicUrl = process.env.PUBLIC_WEB_APP_URL;
  let flow: { execute: jest.Mock };
  let idempotency: {
    reserve: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
  };
  let creators: { resolve: jest.Mock };
  let reads: { findCreatedDocument: jest.Mock };

  const useCase = () =>
    new CreateIntegrationDocumentUseCase(
      flow as unknown as CreateDocumentSignatureFlowUseCase,
      idempotency as unknown as IntegrationIdempotencyService,
      creators as unknown as IntegrationCreatorService,
      reads as unknown as DocumentReadService,
    );
  const request = (payload = PAYLOAD) => ({
    apiClient: API_CLIENT,
    payload,
    file: FILE,
    ip: '203.0.113.7',
    idempotencyKey: 'erp-pedido-1',
    requestHash: 'hash-1',
  });

  beforeEach(() => {
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.com/';
    flow = { execute: jest.fn().mockResolvedValue({ data: { id: 'doc-1' } }) };
    idempotency = {
      reserve: jest
        .fn()
        .mockResolvedValue({ kind: 'RESERVED', reservationId: 'res-1' }),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    creators = {
      resolve: jest.fn().mockResolvedValue({
        user: { id: 'user-ana' },
        account: { id: 'account-ana-org1' },
        provisioned: { user: true, membership: true },
      }),
    };
    reads = { findCreatedDocument: jest.fn().mockResolvedValue(CREATED) };
  });

  afterAll(() => {
    process.env.PUBLIC_WEB_APP_URL = originalPublicUrl;
  });

  it('crea el documento a nombre del creador resuelto, con la llave como origen', async () => {
    const result = await useCase().execute(request());

    expect(creators.resolve).toHaveBeenCalledWith({
      organizationId: 'org-1',
      email: 'Ana@Cliente.com',
      firstName: 'Ana',
      lastName: 'López',
      actorUserId: 'user-actor',
    });
    expect(flow.execute).toHaveBeenCalledWith(
      'user-ana',
      'account-ana-org1',
      expect.objectContaining({
        documentData: expect.objectContaining({ fileName: 'contrato.pdf' }),
      }),
      FILE,
      '203.0.113.7',
      expect.objectContaining({
        apiKeyId: 'key-1',
        apiKeyName: 'Integración ERP',
        onDocumentSaved: expect.any(Function),
      }),
    );
    expect(result).toEqual({
      success: true,
      message: expect.any(String),
      replayed: false,
      data: {
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
        signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        fileName: 'contrato.pdf',
        createdAt: CREATED.createdAt,
        creator: { email: 'ana@cliente.com' },
        participantsCount: 1,
        publicUrl: 'https://app.firmalo.com/public/documents/doc-1',
      },
    });
  });

  it('reserva la clave antes de resolver al creador y la completa en la transacción del alta', async () => {
    await useCase().execute(request());

    expect(idempotency.reserve).toHaveBeenCalledWith({
      apiKeyId: 'key-1',
      idempotencyKey: 'erp-pedido-1',
      requestHash: 'hash-1',
    });
    expect(idempotency.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      creators.resolve.mock.invocationCallOrder[0],
    );

    const { onDocumentSaved } = flow.execute.mock.calls[0][5];
    const manager = {};
    await onDocumentSaved(manager, { id: 'doc-1' });
    expect(idempotency.complete).toHaveBeenCalledWith(
      manager,
      'res-1',
      'doc-1',
    );
  });

  it('una clave ya completada devuelve el documento original sin crear ni aprovisionar nada', async () => {
    idempotency.reserve.mockResolvedValue({
      kind: 'REPLAY',
      documentId: 'doc-1',
    });

    const result = await useCase().execute(request());

    expect(result.replayed).toBe(true);
    expect(result.data?.id).toBe('doc-1');
    expect(creators.resolve).not.toHaveBeenCalled();
    expect(flow.execute).not.toHaveBeenCalled();
  });

  it('propaga el 409 de una clave usada con otro contenido', async () => {
    idempotency.reserve.mockRejectedValue(
      new IdempotencyKeyMismatchException(),
    );

    await expect(useCase().execute(request())).rejects.toBeInstanceOf(
      IdempotencyKeyMismatchException,
    );
    expect(flow.execute).not.toHaveBeenCalled();
  });

  it('si el alta falla, libera la reserva para que el cliente pueda reintentar', async () => {
    flow.execute.mockRejectedValue(new Error('sin créditos'));

    await expect(useCase().execute(request())).rejects.toThrow('sin créditos');
    expect(idempotency.release).toHaveBeenCalledWith('res-1');
  });

  it('si falla al resolver al creador, también libera la reserva', async () => {
    creators.resolve.mockRejectedValue(new Error('membresía dada de baja'));

    await expect(useCase().execute(request())).rejects.toThrow(
      'membresía dada de baja',
    );
    expect(idempotency.release).toHaveBeenCalledWith('res-1');
  });

  it('rechaza requiresApproval: true antes de ocupar la clave', async () => {
    await expect(
      useCase().execute(
        request({
          ...PAYLOAD,
          document: { ...PAYLOAD.document, requiresApproval: true },
        }),
      ),
    ).rejects.toBeInstanceOf(IntegrationApprovalNotSupportedException);
    expect(idempotency.reserve).not.toHaveBeenCalled();
  });
});
