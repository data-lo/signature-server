import { Test, TestingModule } from '@nestjs/testing';
import { SignatureService } from './signature.service';
import { describe, beforeEach, it } from 'node:test';

describe('SignatureService', () => {
  let service: SignatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SignatureService],
    }).compile();

    service = module.get<SignatureService>(SignatureService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

function expect(service: SignatureService) {
  return {
    toBeDefined(): void {
      if (service === undefined || service === null) {
        throw new Error('Expected service to be defined');
      }
    },
  };
}

