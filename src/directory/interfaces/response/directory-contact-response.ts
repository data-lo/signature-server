import { ApiProperty } from '@nestjs/swagger';

/** Un contacto del directorio, tal como lo publica la API. */
export class DirectoryContactResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana' })
  firstName: string;

  @ApiProperty({ example: 'García' })
  lastName: string;

  /** El correo normalizado: es el que identifica al contacto dentro del directorio. */
  @ApiProperty({ example: 'ana@example.com' })
  email: string;

  @ApiProperty({ example: 'GAAA900101XXX', nullable: true, type: String })
  taxId: string | null;

  @ApiProperty({ example: '+526141234567', nullable: true, type: String })
  phone: string | null;

  /** Cuenta personal de la plataforma vinculada; `null` para un contacto externo. */
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  linkedPersonalAccountId: string | null;

  /** `null` mientras el contacto está vigente; con fecha, ya archivado. */
  @ApiProperty({ nullable: true, type: Date })
  archivedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class DirectoryContactsPagination {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  limit: number;

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 2 })
  totalPages: number;
}

/** Respuesta de `GET /directory/contacts`, con la misma forma que el listado de documentos. */
export class DirectoryContactListResponse {
  @ApiProperty({ type: [DirectoryContactResponse] })
  items: DirectoryContactResponse[];

  @ApiProperty({ type: DirectoryContactsPagination })
  pagination: DirectoryContactsPagination;
}
