import { ForbiddenException } from '@nestjs/common';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';
import { GetBiometricSignatureStatusUseCase } from './get-biometric-signature-status.use-case';

const AUTHORIZATION = { userId: 'user-1' } as unknown as AuthorizationContext;

describe('GetBiometricSignatureStatusUseCase', () => {
  let document: Record<string, unknown>;
  let me: Record<string, unknown> | undefined;
  let latest: Record<string, unknown> | null;
  let useCase: GetBiometricSignatureStatusUseCase;

  beforeEach(() => {
    document = { id: 'doc-1', status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE };
    me = { id: 'col-1', status: COLLABORATOR_STATUS_ENUM.PENDING };
    latest = {
      id: 'attempt-1',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
      providerMetadata: { hostedUrl: 'https://verify.didit.me/s/1' },
      expiresAt: null,
    };
    const repository = { findOne: jest.fn(async () => latest) };

    useCase = new GetBiometricSignatureStatusUseCase(
      {
        findOne: jest.fn(async () => document),
        findOrLinkMySignerCollaborator: jest.fn(async () => ({
          signerCollaborators: me ? [me] : [],
          myParticipant: me,
        })),
      } as never,
      { assertCanSign: jest.fn() } as never,
      new BiometricSignatureAttemptService(repository as never),
    );
  });

  it('devuelve el último intento con su URL mientras sigue abierto', async () => {
    await expect(
      useCase.execute('doc-1', 'user-1', AUTHORIZATION),
    ).resolves.toEqual(
      expect.objectContaining({
        attemptId: 'attempt-1',
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
        url: 'https://verify.didit.me/s/1',
        signatureCompleted: false,
        documentCompleted: false,
      }),
    );
  });

  it('sin URL una vez aprobado, y dice si con esa firma el documento quedó completo', async () => {
    latest!.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
    me!.status = COLLABORATOR_STATUS_ENUM.SIGNED;
    document.status = DOCUMENT_STATUS_ENUM.SIGNED;

    await expect(
      useCase.execute('doc-1', 'user-1', AUTHORIZATION),
    ).resolves.toEqual(
      expect.objectContaining({
        url: null,
        signatureCompleted: true,
        documentCompleted: true,
      }),
    );
  });

  it('devuelve null si el firmante nunca inició una sesión', async () => {
    latest = null;

    await expect(
      useCase.execute('doc-1', 'user-1', AUTHORIZATION),
    ).resolves.toBeNull();
  });

  it('responde 403 a quien no es firmante', async () => {
    me = undefined;

    await expect(
      useCase.execute('doc-1', 'user-1', AUTHORIZATION),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
