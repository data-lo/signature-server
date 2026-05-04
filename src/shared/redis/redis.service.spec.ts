import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from './redis.service';
import { beforeEach, describe, it } from 'node:test';

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisService],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should be defined', () => {
  });
});

