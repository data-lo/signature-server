import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuditService } from './audit.service';
import { AuditDocument } from './schema/audit-document';
import { HashService } from '../shared/hash/hash.service';

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getModelToken(AuditDocument.name),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            countDocuments: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: HashService,
          useValue: {
            generateRegistryHash: jest.fn(),
            generateCiperHash: jest.fn(),
            reverseCiperHash: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
