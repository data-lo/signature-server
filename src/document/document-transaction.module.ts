import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentTransactionEntity } from './entities/document-transaction.entity';
import { DocumentTransactionService } from './document-transaction.service';
import { SharedModule } from 'src/shared/shared.module';

/**
 * Módulo independiente de DocumentModule/KafkaModule para evitar un import circular:
 * DocumentModule ya importa KafkaModule (para DocumentEventsProducer), y el consumer de Kafka
 * (DocumentEventsConsumer) también necesita registrar transacciones al procesar el evento de
 * firma — ambos importan este módulo en vez de depender uno del otro.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentTransactionEntity]),
    SharedModule,
  ],
  providers: [DocumentTransactionService],
  exports: [DocumentTransactionService],
})
export class DocumentTransactionModule {}
