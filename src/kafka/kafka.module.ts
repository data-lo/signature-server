import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaTestController } from './kafka-test.controller';
import { KAFKA_SERVICE } from './kafka.constants';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: KAFKA_SERVICE,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: config.get('KAFKA_CLIENT_ID'),
              brokers: [config.get('KAFKA_BROKER')],
            },
            consumer: {
              groupId: config.get('KAFKA_CONSUMER_GROUP_ID'),
            },
          },
        }),
      },
    ]),
  ],
  controllers: [KafkaTestController],
  providers: [KafkaProducerService],
  exports: [ClientsModule, KafkaProducerService],
})
export class KafkaModule {}
