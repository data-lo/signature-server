import { Test, TestingModule } from '@nestjs/testing';
import { EfirmaController } from './efirma.controller';
import { EfirmaService } from './efirma.service';

describe('EfirmaController', () => {
  let controller: EfirmaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EfirmaController],
      providers: [EfirmaService],
    }).compile();

    controller = module.get<EfirmaController>(EfirmaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
