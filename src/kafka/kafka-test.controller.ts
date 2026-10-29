import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

@Controller()
export class KafkaTestController {
  private readonly logger = new Logger(KafkaTestController.name);

  @EventPattern('signature.test')
  handleTestMessage(@Payload() message: unknown) {
    this.logger.log(`Received test message: ${JSON.stringify(message)}`);
  }
}
