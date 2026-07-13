import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs'; // 1. Importa esto de RxJS
import { KAFKA_SERVICE } from './kafka.constants';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(@Inject(KAFKA_SERVICE) private readonly client: ClientKafka) {}

  async onModuleInit() {
    await this.client.connect();
  }

  async onApplicationBootstrap() {
    try {
      this.logger.log('Sending initial connectivity check to Kafka...');
      
      await lastValueFrom(
        this.emit('signature.test', {
          message: 'signature-server kafka connectivity check',
          timestamp: new Date().toISOString(),
        })
      );
      
      this.logger.log('Initial connectivity check message sent successfully!');
    } catch (error) {
      this.logger.error('Failed to send connectivity check message', error);
    }
  }

  emit<T>(topic: string, payload: T) {
    this.logger.log(`Emitting message to topic "${topic}"`);
    return this.client.emit(topic, payload);
  }

  async onModuleDestroy() {
    await this.client.close();
  }
}