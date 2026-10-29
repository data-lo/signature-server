import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { GetDocumentAuditTrailUseCase } from './applications/get-document-audit-trail.use-case';
import { GetDecryptedAuditRecordsUseCase } from './applications/get-decrypted-audit-records.use-case';
import { GetAuditRecordsUseCase } from './applications/get-audit-records.use-case';

describe('AuditController', () => {
  let controller: AuditController;
  let getDocumentAuditTrail: { execute: jest.Mock };
  let getDecryptedAuditRecords: { execute: jest.Mock };
  let getAuditRecords: { execute: jest.Mock };

  beforeEach(async () => {
    getDocumentAuditTrail = { execute: jest.fn() };
    getDecryptedAuditRecords = { execute: jest.fn() };
    getAuditRecords = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        {
          provide: GetDocumentAuditTrailUseCase,
          useValue: getDocumentAuditTrail,
        },
        {
          provide: GetDecryptedAuditRecordsUseCase,
          useValue: getDecryptedAuditRecords,
        },
        { provide: GetAuditRecordsUseCase, useValue: getAuditRecords },
      ],
    }).compile();

    controller = module.get<AuditController>(AuditController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findByDocument delega en GetDocumentAuditTrailUseCase', () => {
    controller.findByDocument('doc-1');

    expect(getDocumentAuditTrail.execute).toHaveBeenCalledWith('doc-1');
  });

  it('findAllDecrypted delega en GetDecryptedAuditRecordsUseCase', () => {
    controller.findAllDecrypted({ page: '2' });

    expect(getDecryptedAuditRecords.execute).toHaveBeenCalledWith({
      page: '2',
    });
  });

  it('findAll delega en GetAuditRecordsUseCase', () => {
    controller.findAll({ id: 'audit-1' });

    expect(getAuditRecords.execute).toHaveBeenCalledWith({ id: 'audit-1' });
  });
});
