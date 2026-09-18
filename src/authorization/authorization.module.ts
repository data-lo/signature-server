import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { RolesModule } from 'src/roles/roles.module';

import { AuthorizationController } from './authorization.controller';
import { GetAuthorizationContextUseCase } from './applications/get-authorization-context.use-case';

/**
 * Autorización: qué puede hacer el usuario, separado de `auth` (quién es) y de `roles` (qué
 * existe en el catálogo).
 *
 * Hoy publica una sola cosa, el contexto efectivo de la cuenta activa, que es lo que el
 * frontend necesita para construir su navegación. La autorización que de verdad protege sigue
 * viviendo en cada endpoint.
 *
 * Importa `AccountEntity` suelta y no `AccountModule`: lo único que necesita de cuentas es leer
 * la fila de la membresía activa, y arrastrar el módulo entero crearía un ciclo (`AccountModule`
 * ya importa `RolesModule`) a cambio de nada — el mismo criterio que ya sigue `RolesModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountEntity]), RolesModule],
  controllers: [AuthorizationController],
  providers: [GetAuthorizationContextUseCase],
})
export class AuthorizationModule {}
