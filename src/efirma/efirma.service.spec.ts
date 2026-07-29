import { Test, TestingModule } from '@nestjs/testing';
import { EfirmaService } from './efirma.service';

describe('EfirmaService', () => {
  let service: EfirmaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EfirmaService],
    }).compile();

    service = module.get<EfirmaService>(EfirmaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
