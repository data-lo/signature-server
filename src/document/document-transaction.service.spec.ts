import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DocumentTransactionService } from './document-transaction.service';
import { DocumentTransactionEntity } from './entities/document-transaction.entity';
import { HashService } from 'src/shared/hash/hash.service';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'transaction-1', ...data })),
  };
}

describe('DocumentTransactionService', () => {
  let service: DocumentTransactionService;
  let repository: ReturnType<typeof createMockRepository>;
  let transactionalRepository: ReturnType<typeof createMockRepository>;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let hashService: Record<string, jest.Mock>;

  beforeEach(async () => {
    repository = createMockRepository();
    transactionalRepository = createMockRepository();
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(transactionalRepository),
    };
    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    hashService = {
      generateRegistryHash: jest.fn().mockResolvedValue('actual-hash-nuevo'),
      generateCiperHash: jest.fn().mockResolvedValue('cipher-content'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentTransactionService,
        {
          provide: getRepositoryToken(DocumentTransactionEntity),
          useValue: repository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: HashService, useValue: hashService },
      ],
    }).compile();

    service = module.get<DocumentTransactionService>(
      DocumentTransactionService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createInitial', () => {
    it('crea el registro inicial con chainHash vacío y el actualHash del archivo', async () => {
      const result = await service.createInitial('doc-1', 'file-hash-123');

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          collaboratorId: null,
          actualHash: 'file-hash-123',
          chainHash: '',
          chipher: 'cipher-content',
        }),
      );
      expect(result.chainHash).toBe('');
    });

    it('usa el EntityManager transaccional cuando se le pasa uno (ver DocumentSignaturesService)', async () => {
      const transactionalRepository = createMockRepository();
      const manager = {
        getRepository: jest.fn().mockReturnValue(transactionalRepository),
      } as any;

      await service.createInitial('doc-1', 'file-hash-123', manager);

      expect(manager.getRepository).toHaveBeenCalledWith(
        DocumentTransactionEntity,
      );
      expect(transactionalRepository.save).toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('registerSignature', () => {
    it('toma el advisory lock (namespace + hashtext(documentId)) antes de leer o escribir', async () => {
      transactionalRepository.find.mockResolvedValue([]);

      await service.registerSignature('doc-1', 'collaborator-1', 'sig-hash');

      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1, hashtext($2))',
        [expect.any(Number), 'doc-1'],
      );
    });

    it('encadena chainHash = actualHash del registro anterior cuando ya existe uno', async () => {
      transactionalRepository.find.mockResolvedValue([
        {
          id: 'transaction-0',
          documentId: 'doc-1',
          actualHash: 'actual-hash-anterior',
          chainHash: '',
        },
      ]);

      await service.registerSignature('doc-1', 'collaborator-1', 'sig-hash');

      expect(transactionalRepository.find).toHaveBeenCalledWith({
        where: { documentId: 'doc-1' },
        order: { timeStamp: 'DESC' },
      });
      expect(transactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          collaboratorId: 'collaborator-1',
          chainHash: 'actual-hash-anterior',
          actualHash: 'actual-hash-nuevo',
        }),
      );
    });

    it('usa chainHash vacío si no hay ningún registro previo (documento sin transacción inicial)', async () => {
      transactionalRepository.find.mockResolvedValue([]);

      await service.registerSignature('doc-1', 'collaborator-1', 'sig-hash');

      expect(transactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ chainHash: '' }),
      );
    });
  });

  describe('registerCompletion', () => {
    const initialRecord = {
      id: 'transaction-0',
      documentId: 'doc-1',
      collaboratorId: null,
      actualHash: 'hash-inicial',
      chainHash: '',
    };

    it('encadena el registro final sin collaboratorId, con el actualHash del último registro', async () => {
      transactionalRepository.find.mockResolvedValue([initialRecord]);

      await service.registerCompletion('doc-1', 'hash-del-pdf-final');

      expect(transactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          collaboratorId: null,
          chainHash: 'hash-inicial',
          actualHash: 'actual-hash-nuevo',
        }),
      );
    });

    it('incluye el hash del PDF firmado en el contenido hasheado del registro', async () => {
      transactionalRepository.find.mockResolvedValue([initialRecord]);

      await service.registerCompletion('doc-1', 'hash-del-pdf-final');

      expect(hashService.generateRegistryHash).toHaveBeenCalledWith(
        expect.objectContaining({ signedHash: 'hash-del-pdf-final' }),
      );
    });

    it('es idempotente: si el documento ya tiene registro final, no encadena otro', async () => {
      const completionRecord = {
        id: 'transaction-final',
        documentId: 'doc-1',
        collaboratorId: null,
        actualHash: 'hash-final',
        chainHash: 'hash-anterior',
      };
      transactionalRepository.find.mockResolvedValue([
        completionRecord,
        initialRecord,
      ]);

      const result = await service.registerCompletion('doc-1', 'hash-nuevo');

      expect(transactionalRepository.save).not.toHaveBeenCalled();
      expect(result).toBe(completionRecord);
    });

    it('el registro inicial no se confunde con uno final (se distinguen por chainHash vacío)', async () => {
      transactionalRepository.find.mockResolvedValue([initialRecord]);

      await service.registerCompletion('doc-1', 'hash-del-pdf-final');

      expect(transactionalRepository.save).toHaveBeenCalled();
    });

    it('toma el mismo advisory lock por documento que registerSignature', async () => {
      transactionalRepository.find.mockResolvedValue([initialRecord]);

      await service.registerCompletion('doc-1', 'hash-del-pdf-final');

      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1, hashtext($2))',
        [expect.any(Number), 'doc-1'],
      );
    });
  });

  describe('findAllForDocument', () => {
    it('retorna las transacciones del documento ordenadas cronológicamente', async () => {
      repository.find.mockResolvedValue([{ id: 'transaction-1' }]);

      const result = await service.findAllForDocument('doc-1');

      expect(repository.find).toHaveBeenCalledWith({
        where: { documentId: 'doc-1' },
        order: { timeStamp: 'ASC' },
      });
      expect(result).toEqual([{ id: 'transaction-1' }]);
    });
  });
});
