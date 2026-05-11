import { ApiProperty } from '@nestjs/swagger';

export enum ApiResponseMessage {
  SUCCESS = 'Operación realizada con éxito',
  CREATED = 'Recurso creado correctamente',
  NOT_FOUND = 'Recurso no encontrado',
  INVALID_DATA = 'Datos de entrada inválidos',
  UNAUTHORIZED = 'No autorizado para realizar esta acción',
  FORBIDDEN = 'El firmante no está asociado al recurso',
  CONFLICT = 'El recurso ya existe',
  SERVER_ERROR = 'Error interno del servidor',
}

export class ApiResponseDto {
  @ApiProperty({ example: 200, description: 'Código de estado HTTP de la respuesta' })
  success: boolean;

  @ApiProperty({
    example: ApiResponseMessage.SUCCESS,
    description: 'Mensaje descriptivo del resultado de la operación',
    enum: ApiResponseMessage,
  })
  message: string;
}

export class ApiNotFoundResponseDto {
  @ApiProperty({ example: 404, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({ example: ApiResponseMessage.NOT_FOUND, enum: ApiResponseMessage, description: 'Mensaje de error' })
  message: string;

  @ApiProperty({ example: 'Not Found', description: 'Tipo de error HTTP' })
  error: string;
}

export class ApiInvalidDataResponseDto {
  @ApiProperty({ example: 400, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({ example: ApiResponseMessage.INVALID_DATA, enum: ApiResponseMessage, description: 'Mensaje de error' })
  message: string;

  @ApiProperty({ example: 'Bad Request', description: 'Tipo de error HTTP' })
  error: string;
}

export class ApiForbiddenResponseDto {
  @ApiProperty({ example: 403, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({ example: ApiResponseMessage.FORBIDDEN, enum: ApiResponseMessage, description: 'Mensaje de error' })
  message: string;

  @ApiProperty({ example: 'Forbidden', description: 'Tipo de error HTTP' })
  error: string;
}

export class ApiUnauthorizedResponseDto {
  @ApiProperty({ example: 401, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({ example: ApiResponseMessage.UNAUTHORIZED, enum: ApiResponseMessage, description: 'Mensaje de error' })
  message: string;

  @ApiProperty({ example: 'Unauthorized', description: 'Tipo de error HTTP' })
  error: string;
}
