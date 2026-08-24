import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { IdentityVerificationModule } from './identity-verification.module';
import { IdentityVerificationEntity } from './entities/identity-verification.entity';
import { IdentityVerificationsController } from './identity-verifications.controller';
import { ProcessDiditVerificationResultUseCase } from './applications/process-didit-verification-result.use-case';
import { UpdateSigningCredentialStatusUseCase } from './applications/update-signing-credential-status.use-case';

/**
 * Los errores de cableado de Nest sólo aparecen al arrancar la aplicación contra Postgres,
 * Mongo y Redis; sin esta prueba se descubrirían en el despliegue. También fija el contrato
 * hacia afuera: `ProcessDiditVerificationResultUseCase` (que consumirá el módulo de webhooks) y
 * `UpdateSigningCredentialStatusUseCase` (que consume `SignatureModule`) tienen que ser
 * resolubles.
 */
describe('IdentityVerificationModule', () => {
  it('resuelve su grafo de dependencias y expone los casos de uso que otros módulos consumen', async () => {
    const repositoryStub = {};

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        IdentityVerificationModule,
      ],
    })
      .overrideProvider(getRepositoryToken(IdentityVerificationEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(UserEntity))
      .useValue(repositoryStub)
      .compile();

    expect(moduleRef.get(IdentityVerificationsController)).toBeDefined();
    expect(moduleRef.get(ProcessDiditVerificationResultUseCase)).toBeDefined();
    expect(moduleRef.get(UpdateSigningCredentialStatusUseCase)).toBeDefined();
  });
});
