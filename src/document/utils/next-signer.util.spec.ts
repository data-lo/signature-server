import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { getNextPendingSigner, isSignerTurn } from './next-signer.util';

function buildCollaborator(
  overrides: Partial<CollaboratorEntity>,
): CollaboratorEntity {
  return {
    id: 'p',
    documentId: 'doc-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: SIGNEE_STATUS_ENUM.PENDING,
    signingOrder: 0,
    ...overrides,
  } as CollaboratorEntity;
}

describe('next-signer.util', () => {
  describe('getNextPendingSigner', () => {
    it('devuelve el firmante pendiente con el signingOrder más bajo', () => {
      const signers = [
        buildCollaborator({ id: 'p-2', signingOrder: 1 }),
        buildCollaborator({ id: 'p-1', signingOrder: 0 }),
        buildCollaborator({ id: 'p-3', signingOrder: 2 }),
      ];

      expect(getNextPendingSigner(signers)?.id).toBe('p-1');
    });

    it('salta a firmantes ya firmados y encuentra el siguiente pendiente', () => {
      const signers = [
        buildCollaborator({
          id: 'p-1',
          signingOrder: 0,
          status: SIGNEE_STATUS_ENUM.SIGNED,
        }),
        buildCollaborator({ id: 'p-2', signingOrder: 1 }),
      ];

      expect(getNextPendingSigner(signers)?.id).toBe('p-2');
    });

    it('ignora colaboradores que no son firmantes (watchers/reviewers)', () => {
      const signers = [
        buildCollaborator({
          id: 'watcher-1',
          signingOrder: 0,
          colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
        }),
        buildCollaborator({
          id: 'reviewer-1',
          signingOrder: 0,
          colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
        }),
        buildCollaborator({ id: 'p-1', signingOrder: 1 }),
      ];

      expect(getNextPendingSigner(signers)?.id).toBe('p-1');
    });

    it('devuelve null si no hay ningún firmante pendiente', () => {
      const signers = [
        buildCollaborator({
          id: 'p-1',
          status: SIGNEE_STATUS_ENUM.SIGNED,
        }),
      ];

      expect(getNextPendingSigner(signers)).toBeNull();
    });
  });

  describe('isSignerTurn', () => {
    it('es true solo para el firmante pendiente con menor signingOrder', () => {
      const signers = [
        buildCollaborator({ id: 'p-1', signingOrder: 0 }),
        buildCollaborator({ id: 'p-2', signingOrder: 1 }),
      ];

      expect(isSignerTurn(signers[0], signers)).toBe(true);
      expect(isSignerTurn(signers[1], signers)).toBe(false);
    });
  });
});
