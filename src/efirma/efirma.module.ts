import { Module } from '@nestjs/common';
import { EfirmaService } from './efirma.service';
import { EfirmaController } from './efirma.controller';

@Module({
  controllers: [EfirmaController],
  providers: [EfirmaService],
})
export class EfirmaModule {}
