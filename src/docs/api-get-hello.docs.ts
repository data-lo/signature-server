import { applyDecorators } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

export function ApiGetHello() {
  return applyDecorators(ApiExcludeEndpoint());
}
