import { Module } from '@nestjs/common';
import { MinioService } from './minio/minio.service';
import { RedisService } from './redis/redis.service';
import { HashService } from './hash/hash.service';

@Module({
  providers: [MinioService, RedisService, HashService],
  exports: [MinioService, RedisService, HashService],
})
export class SharedModule {}
