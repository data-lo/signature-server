import { Module } from '@nestjs/common';
import { MinioService } from './minio/minio.service';
import { RedisService } from './redis/redis.service';

@Module({
  providers: [MinioService, RedisService],
  exports: [MinioService, RedisService],
})
export class SharedModule {}
