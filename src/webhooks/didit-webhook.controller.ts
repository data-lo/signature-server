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
import { ReceiveDiditWebhookUseCase } from './applications/receive-didit-webhook.use-case';
import { WebhookReceptionResult } from './interfaces/webhook-reception-result.interface';

/**
 * Endpoint público: lo invoca Didit, no un navegador con sesión. `@SkipJwtAuth()` lo saca de
 * los dos guards globales (x-api-key y JWT) — Didit no puede presentar ninguna de las dos
 * credenciales. Lo que autentica la petición es la firma HMAC del cuerpo, verificada dentro
 * del caso de uso antes de tocar cualquier dato.
 */
@ApiExcludeController()
@Controller('webhooks')
export class DiditWebhookController {
  constructor(
    private readonly receiveDiditWebhook: ReceiveDiditWebhookUseCase,
  ) {}

  @Post('didit')
  @SkipJwtAuth()
  @HttpCode(HttpStatus.OK)
  async handle(
    /**
     * `request.rawBody` (habilitado con `rawBody: true` en `main.ts`) y no `@Body()`: el HMAC
     * se calcula sobre los bytes exactos que mandó Didit. Volver a serializar el objeto ya
     * parseado altera espacios y orden de llaves, y la firma dejaría de coincidir siempre.
     */
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
    @Headers('x-timestamp') timestamp: string,
  ): Promise<WebhookReceptionResult> {
    return this.receiveDiditWebhook.execute({
      rawBody: request.rawBody,
      signature,
      timestamp,
    });
  }
}
