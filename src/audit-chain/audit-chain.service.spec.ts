import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  AuditChainService,
  AUDIT_CHAIN_GENESIS_HASH,
} from './audit-chain.service';
import { AUDIT_TYPE_ENUM } from './enums/audit-type.enum';
import { HashService } from 'src/shared/hash/hash.service';

function createMockRepository() {
  return {
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 1, ...data })),
  };
}

describe('AuditChainService', () => {
  let service: AuditChainService;
  let repository: ReturnType<typeof createMockRepository>;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let hashService: Record<string, jest.Mock>;

  beforeEach(async () => {
    repository = createMockRepository();
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    hashService = {
      generateCiperHash: jest.fn().mockResolvedValue('cipher-content'),
      generateChainedHash: jest.fn().mockResolvedValue('actual-hash-nuevo'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditChainService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: HashService, useValue: hashService },
      ],
    }).compile();

    service = module.get<AuditChainService>(AuditChainService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('toma el advisory lock (pg_advisory_xact_lock) antes de leer o escribir', async () => {
    repository.find.mockResolvedValue([]);

    await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.CREATED,
    });

    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1)',
      [expect.any(Number)],
    );
  });

  it('usa el Genesis Hash (64 ceros) cuando no hay ninguna fila previa en el sistema', async () => {
    repository.find.mockResolvedValue([]);

    const result = await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.CREATED,
    });

    expect(AUDIT_CHAIN_GENESIS_HASH).toBe('0'.repeat(64));
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ chainHash: AUDIT_CHAIN_GENESIS_HASH }),
    );
    expect(result.chainHash).toBe(AUDIT_CHAIN_GENESIS_HASH);
  });

  it('encadena chainHash = actualHash de la fila con MAX(id) global anterior', async () => {
    repository.find.mockResolvedValue([{ id: 5, actualHash: 'hash-previo' }]);

    await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.SIGNATURES_COMPLETED,
    });

    expect(repository.find).toHaveBeenCalledWith({
      order: { id: 'DESC' },
      take: 1,
    });
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        chainHash: 'hash-previo',
        actualHash: 'actual-hash-nuevo',
      }),
    );
  });

  it('calcula actualHash como SHA256(documentId + chipher + chainHash + auditType + timestamp)', async () => {
    repository.find.mockResolvedValue([]);
    const fixedDate = new Date('2026-01-01T00:00:00.000Z');

    await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.CREATED,
      timestamp: fixedDate,
    });

    expect(hashService.generateChainedHash).toHaveBeenCalledWith(
      'doc-1',
      'cipher-content',
      AUDIT_CHAIN_GENESIS_HASH,
      AUDIT_TYPE_ENUM.CREATED,
      fixedDate.toISOString(),
    );
  });

  it('cifra documentId/auditType/metadata/timestamp y persiste el chipher resultante', async () => {
    repository.find.mockResolvedValue([]);

    await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.PENDING,
      metadata: { actorUserId: 'user-1' },
    });

    expect(hashService.generateCiperHash).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        auditType: AUDIT_TYPE_ENUM.PENDING,
        metadata: { actorUserId: 'user-1' },
      }),
    );
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ chipher: 'cipher-content' }),
    );
  });

  it('usa la fecha actual si no se provee timestamp explícito', async () => {
    repository.find.mockResolvedValue([]);
    const before = Date.now();

    const result = await service.recordEvent({
      documentId: 'doc-1',
      auditType: AUDIT_TYPE_ENUM.CREATED,
    });

    expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });
});
