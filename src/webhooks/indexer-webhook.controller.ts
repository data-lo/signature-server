import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ReceiveIndexerWebhookUseCase } from './applications/receive-indexer-webhook.use-case';
import { WebhookReceptionResult } from './interfaces/webhook-reception-result.interface';

/**
 * Endpoint público: lo invoca el indexador, no un navegador con sesión. Lo que autentica la petición
 * es la firma HMAC del cuerpo, verificada dentro del caso de uso antes de tocar cualquier dato.
 */
@ApiExcludeController()
@Controller('webhooks')
export class IndexerWebhookController {
  constructor(
    private readonly receiveIndexerWebhook: ReceiveIndexerWebhookUseCase,
  ) {}

  @Post('indexer')
  @SkipJwtAuth()
  @HttpCode(HttpStatus.OK)
  async handle(
    /** `rawBody` y no `@Body()`: el HMAC se calcula sobre los bytes exactos que llegaron. */
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
    @Headers('x-timestamp') timestamp: string,
  ): Promise<WebhookReceptionResult> {
    return this.receiveIndexerWebhook.execute({
      rawBody: request.rawBody,
      signature,
      timestamp,
    });
  }
}
