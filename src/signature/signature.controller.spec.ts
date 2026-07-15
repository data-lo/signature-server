import { Test, TestingModule } from '@nestjs/testing';
import { SignatureController } from './signature.controller';
import { SignatureService } from './signature.service';
import { describe, beforeEach, it } from 'node:test';

describe('SignatureController', () => {
  let controller: SignatureController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SignatureController],
      providers: [SignatureService],
    }).compile();

    controller = module.get<SignatureController>(SignatureController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
