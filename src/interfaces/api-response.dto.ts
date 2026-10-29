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

export class BaseResponse<T = unknown> {
  @ApiProperty({
    example: true,
    description: 'Indica si la operación fue exitosa',
  })
  success: boolean;

  @ApiProperty({
    example: ApiResponseMessage.SUCCESS,
    description: 'Mensaje descriptivo del resultado de la operación',
    enum: ApiResponseMessage,
  })
  message: string;

  @ApiProperty({ description: 'Datos de la respuesta' })
  data?: T;
}

export class NotFoundResponse {
  @ApiProperty({ example: 404, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({
    example: ApiResponseMessage.NOT_FOUND,
    enum: ApiResponseMessage,
    description: 'Mensaje de error',
  })
  message: string;

  @ApiProperty({ example: 'Not Found', description: 'Tipo de error HTTP' })
  error: string;
}

export class BadRequestResponse {
  @ApiProperty({ example: 400, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({
    example: ApiResponseMessage.INVALID_DATA,
    enum: ApiResponseMessage,
    description: 'Mensaje de error',
  })
  message: string;

  @ApiProperty({ example: 'Bad Request', description: 'Tipo de error HTTP' })
  error: string;
}

export class ForbiddenResponse {
  @ApiProperty({ example: 403, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({
    example: ApiResponseMessage.FORBIDDEN,
    enum: ApiResponseMessage,
    description: 'Mensaje de error',
  })
  message: string;

  @ApiProperty({ example: 'Forbidden', description: 'Tipo de error HTTP' })
  error: string;
}

export class UnauthorizedResponse {
  @ApiProperty({ example: 401, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({
    example: ApiResponseMessage.UNAUTHORIZED,
    enum: ApiResponseMessage,
    description: 'Mensaje de error',
  })
  message: string;

  @ApiProperty({ example: 'Unauthorized', description: 'Tipo de error HTTP' })
  error: string;
}

export class ConflictResponse {
  @ApiProperty({ example: 409, description: 'Código de estado HTTP' })
  statusCode: number;

  @ApiProperty({
    example: ApiResponseMessage.CONFLICT,
    enum: ApiResponseMessage,
    description: 'Mensaje de error',
  })
  message: string;

  @ApiProperty({ example: 'Conflict', description: 'Tipo de error HTTP' })
  error: string;
}
