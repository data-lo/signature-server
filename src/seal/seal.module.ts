import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SealService } from './seal.service';
import { SealController } from './seal.controller';
import { SealEntity } from './entities/seal.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SealEntity])],
  controllers: [SealController],
  providers: [SealService],
})
export class SealModule {}
