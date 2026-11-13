import {
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { buildApiKeyErrorBody } from 'src/api-key/exceptions/api-key.exceptions';

/** Códigos estables de error de la configuración de webhooks salientes. */
export enum OUTBOUND_WEBHOOK_ERROR_CODE_ENUM {
  ENDPOINT_NOT_FOUND = 'WEBHOOK_ENDPOINT_NOT_FOUND',
  URL_NOT_ALLOWED = 'WEBHOOK_URL_NOT_ALLOWED',
  SECRET_ENCRYPTION_UNAVAILABLE = 'WEBHOOK_SECRET_ENCRYPTION_UNAVAILABLE',
}

/** Por qué una URL no se acepta como destino; viaja en `details.reason`. */
export enum WEBHOOK_URL_REJECTION_REASON_ENUM {
  INVALID_URL = 'INVALID_URL',
  HTTPS_REQUIRED = 'HTTPS_REQUIRED',
  PORT_NOT_ALLOWED = 'PORT_NOT_ALLOWED',
  CREDENTIALS_NOT_ALLOWED = 'CREDENTIALS_NOT_ALLOWED',
  HOST_NOT_ALLOWED = 'HOST_NOT_ALLOWED',
  HOST_NOT_RESOLVABLE = 'HOST_NOT_RESOLVABLE',
}

/** La organización de la llave todavía no configuró su endpoint de webhooks. */
export class WebhookEndpointNotFoundException extends NotFoundException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.NOT_FOUND,
        'Not Found',
        'La organización no tiene un endpoint de webhooks configurado',
        OUTBOUND_WEBHOOK_ERROR_CODE_ENUM.ENDPOINT_NOT_FOUND,
      ),
    );
  }
}

/**
 * La URL no es un destino permitido (ver `WebhookEndpointUrlPolicy`). Es un 422 de validación, con
 * `details.field = 'url'` y el motivo en `details.reason`.
 */
export class WebhookUrlNotAllowedException extends UnprocessableEntityException {
  constructor(reason: WEBHOOK_URL_REJECTION_REASON_ENUM, message: string) {
    super({
      ...buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        message,
        OUTBOUND_WEBHOOK_ERROR_CODE_ENUM.URL_NOT_ALLOWED,
      ),
      details: { field: 'url', reason },
    });
  }
}

/**
 * Falta o es inválida `WEBHOOK_SECRET_ENCRYPTION_KEY`: el servidor no puede guardar un secreto
 * nuevo. Es un 503 para que el resto del servidor siga funcionando sin la variable.
 */
export class WebhookSecretEncryptionUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Service Unavailable',
        'La configuración de webhooks no está disponible por ahora. Vuelve a intentarlo más tarde.',
        OUTBOUND_WEBHOOK_ERROR_CODE_ENUM.SECRET_ENCRYPTION_UNAVAILABLE,
      ),
    );
  }
}
