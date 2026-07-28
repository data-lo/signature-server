import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditChainEntity } from './entities/audit-chain.entity';
import { AuditChainService } from './audit-chain.service';
import { SharedModule } from 'src/shared/shared.module';

/**
 * Módulo independiente (mismo criterio que DocumentTransactionModule): KafkaModule necesita
 * AuditChainService dentro de DocumentEventsConsumer, y este módulo no depende de KafkaModule
 * ni de DocumentModule — evita cualquier ciclo de imports entre ellos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditChainEntity]), SharedModule],
  providers: [AuditChainService],
  exports: [AuditChainService],
})
export class AuditChainModule {}
