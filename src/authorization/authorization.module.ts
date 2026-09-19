import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { RolesModule } from 'src/roles/roles.module';

import { PermissionsGuard } from './guards/permissions.guard';
import { AuthorizationService } from './services/authorization.service';

/**
 * Autorización general, separada de `auth` (quién eres) y de `roles` (qué existe en el catálogo).
 *
 * Los tres módulos responden preguntas distintas y por eso no se funden:
 *
 * - `auth` autentica: valida el token y la sesión, y deja `request.user`.
 * - `roles` es el catálogo y su persistencia: qué recursos, acciones y alcances hay, y qué le
 *   toca a cada rol.
 * - `authorization` —esto— une las dos cosas en el momento de la petición: resuelve la membresía
 *   activa, consulta el catálogo y decide.
 *
 * `PermissionsGuard` se registra como guard GLOBAL, y este módulo se importa en `AppModule`
 * DESPUÉS de `AuthModule`: Nest ejecuta los guards globales en el orden en que se registran, y
 * este necesita que `JwtAuthGuard` ya haya dejado el usuario en la petición. El orden resultante
 * es `ApiKeyGuard → JwtAuthGuard → PermissionsGuard`.
 *
 * Importa `AccountEntity` suelta y no `AccountModule`: lo único que necesita de cuentas es leer
 * la fila de la membresía activa, y arrastrar el módulo entero crearía un ciclo (`AccountModule`
 * ya importa `RolesModule`) a cambio de nada — el mismo criterio que ya sigue `RolesModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountEntity]), RolesModule],
  providers: [
    AuthorizationService,
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
