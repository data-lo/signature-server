import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { KAFKA_SERVICE } from './kafka.constants';

@Injectable()
export class KafkaProducerService
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(@Inject(KAFKA_SERVICE) private readonly client: ClientKafka) {}

  async onModuleInit() {
    await this.client.connect();
  }

  async onApplicationBootstrap() {
    this.emit('signature.test', {
      message: 'signature-server kafka connectivity check',
      timestamp: new Date().toISOString(),
    });
  }

  emit<T>(topic: string, payload: T) {
    this.logger.log(`Emitting message to topic "${topic}"`);
    return this.client.emit(topic, payload);
  }

  async onModuleDestroy() {
    await this.client.close();
  }
}
