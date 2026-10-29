import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Ruta **relativa** del frontend a la que Didit devuelve al usuario cuando termina el flujo.
 *
 * A propósito no se acepta una URL completa. El backend arma el callback pegando esta ruta a
 * `FRONTEND_URL`, así que aunque un atacante mande `//evil.com` o `https://evil.com`, la
 * validación lo rechaza antes de que llegue a construirse un enlace que Didit mostraría como
 * si fuera nuestro. Es la diferencia entre un parámetro de navegación y un redirect abierto.
 */
const RELATIVE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;

export class CreateDiditSessionDto {
  @ApiPropertyOptional({
    example: '/dashboard/identidad-y-firma',
    description:
      'Ruta relativa del frontend a la que Didit regresa al usuario al terminar. Debe empezar con "/" y no puede ser una URL absoluta.',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(RELATIVE_PATH, {
    message:
      'returnPath debe ser una ruta relativa que empiece con "/" (no se admiten URLs absolutas)',
  })
  returnPath?: string;
}
