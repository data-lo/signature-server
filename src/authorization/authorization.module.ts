import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { RolesModule } from 'src/roles/roles.module';

import { AuthorizationController } from './authorization.controller';
import { GetAuthorizationContextUseCase } from './applications/get-authorization-context.use-case';
import { PermissionsGuard } from './guards/permissions.guard';
import { AuthorizationService } from './services/authorization.service';

/**
 * Autorización: qué puede hacer el usuario, separado de `auth` (quién es) y de `roles` (qué
 * existe en el catálogo).
 *
 * Publica dos cosas. Una es el contexto efectivo de la cuenta activa, que es lo que el frontend
 * necesita para construir su navegación. La otra es `PermissionsGuard`, registrado aquí como
 * `APP_GUARD`: es lo que convierte `@RequirePermission` en una comprobación de verdad. Sin ese
 * registro el decorador sólo escribe metadata que nadie lee, y los endpoints anotados quedan con
 * la autorización que tuvieran por su cuenta — que en varios era ninguna, porque su caso de uso
 * ya la había delegado en el guard.
 *
 * **El orden de los tres guards globales importa y lo decide el orden de los imports de
 * `AppModule`.** `AuthModule` va antes que este módulo, así que la cadena queda `ApiKeyGuard` →
 * `JwtAuthGuard` → `PermissionsGuard`, que es la única que funciona: el último necesita el
 * `request.user` que deja el segundo.
 *
 * Importa `AccountEntity` suelta y no `AccountModule`: lo único que necesita de cuentas es leer
 * la fila de la membresía activa, y arrastrar el módulo entero crearía un ciclo (`AccountModule`
 * ya importa `RolesModule`) a cambio de nada — el mismo criterio que ya sigue `RolesModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountEntity]), RolesModule],
  controllers: [AuthorizationController],
  providers: [
    GetAuthorizationContextUseCase,
    AuthorizationService,
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
