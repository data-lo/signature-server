import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as request from 'supertest';

import { AppModule } from './../src/app.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { UserEntity } from './../src/user/entities/user.entity';
import { PersonalInformationEntity } from './../src/user/entities/personal-information.entity';
import { AccountEntity } from './../src/account/entities/account.entity';
import { OrganizationEntity } from './../src/account/entities/organization.entity';
import { ACCOUNT_TYPE_ENUM } from './../src/account/enums/account-type.enum';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from './../src/user/enums/signing-credential-status.enum';

const APP_BOOT_TIMEOUT_MS = 60_000;

/**
 * Reproduce el ticket "Persistencia de error de permisos al generar una organización": crear una
 * organización y, de inmediato, consultar sus miembros y su catálogo de permisos como quien la
 * creó. Corre contra el `AppModule` real y Postgres real —no repos en memoria— porque lo que se
 * quiere afirmar es justo lo que un mock no puede mentir: que la fila de membresía ADMIN quedó
 * COMMITEADA y visible para la siguiente petición HTTP, con el guard JWT real de por medio.
 *
 * Los usuarios y la organización son datos de prueba propios, creados y borrados en este archivo:
 * no depende de que exista cierto registro en la base de quien lo corra.
 */
describe('Crear organización y consultar su detalle de inmediato (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let userRepository: Repository<UserEntity>;
  let personalInformationRepository: Repository<PersonalInformationEntity>;
  let accountRepository: Repository<AccountEntity>;
  let organizationRepository: Repository<OrganizationEntity>;

  let creator: UserEntity;
  let creatorPersonalAccount: AccountEntity;
  let outsider: UserEntity;
  let outsiderPersonalAccount: AccountEntity;
  const createdOrganizationIds: string[] = [];

  async function createTestUser(label: string) {
    const personalInformation = await personalInformationRepository.save(
      personalInformationRepository.create({
        name: label,
        lastName: 'E2E',
        curp: `CURP${label}${Date.now()}`.slice(0, 18).toUpperCase(),
        rfc: null,
        phoneNumber: null,
        secondaryEmail: null,
        frontImageKey: null,
        backImageKey: null,
      }),
    );

    const user = await userRepository.save(
      userRepository.create({
        firstName: label,
        lastName: 'E2E',
        email: `${label.toLowerCase()}-${Date.now()}@e2e.example.com`,
        roles: ['USER'],
        isActive: true,
        isDeleted: false,
        isConfigured: true,
        isEmailVerified: true,
        nationalId: `NID${label}${Date.now()}`.slice(0, 18).toUpperCase(),
        password: 'hash-no-usado-en-esta-prueba',
        signatureId: null,
        signingCredentialStatus:
          SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
        identityVerifiedAt: null,
        personalInformationId: personalInformation.id,
      }),
    );

    const personalAccount = await accountRepository.save(
      accountRepository.create({
        userId: user.id,
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        roleId: null,
        isActive: true,
        email: user.email,
        password: user.password,
        joinedAt: new Date(),
      }),
    );

    return { user, personalAccount };
  }

  function tokenFor(user: UserEntity) {
    return jwtService.signAsync({
      sub: user.id,
      email: user.email,
      roles: user.roles,
      nationalId: user.nationalId,
      jti: `e2e-${user.id}-${Date.now()}`,
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalApiPrefix(app);
    await app.init();

    jwtService = app.get(JwtService);
    userRepository = app.get(getRepositoryToken(UserEntity));
    personalInformationRepository = app.get(
      getRepositoryToken(PersonalInformationEntity),
    );
    accountRepository = app.get(getRepositoryToken(AccountEntity));
    organizationRepository = app.get(getRepositoryToken(OrganizationEntity));

    ({ user: creator, personalAccount: creatorPersonalAccount } =
      await createTestUser('Creator'));
    ({ user: outsider, personalAccount: outsiderPersonalAccount } =
      await createTestUser('Outsider'));
  }, APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    // Orden por dependencias: primero las organizaciones (su borrado arrastra en cascada las
    // membresías que apuntan a ellas), luego las cuentas personales, luego los usuarios y su
    // información personal.
    if (createdOrganizationIds.length > 0) {
      await organizationRepository.delete(createdOrganizationIds);
    }
    if (creatorPersonalAccount) {
      await accountRepository.delete(creatorPersonalAccount.id);
    }
    if (outsiderPersonalAccount) {
      await accountRepository.delete(outsiderPersonalAccount.id);
    }
    if (creator) {
      await userRepository.delete(creator.id);
      await personalInformationRepository.delete(creator.personalInformationId);
    }
    if (outsider) {
      await userRepository.delete(outsider.id);
      await personalInformationRepository.delete(
        outsider.personalInformationId,
      );
    }

    await app?.close();
  });

  it('el creador puede consultar los miembros y los permisos justo después de crearla', async () => {
    const creatorToken = await tokenFor(creator);

    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${creatorToken}`)
      .set('X-Account-Id', creatorPersonalAccount.id)
      .send({
        name: 'Organización E2E',
        organizationName: 'Organización E2E S.A. de C.V.',
      });

    expect(createResponse.status).toBe(201);
    const organizationId: string = createResponse.body.data.organizationId;
    expect(organizationId).toBeTruthy();
    createdOrganizationIds.push(organizationId);

    const membersResponse = await request(app.getHttpServer())
      .get(`/api/v1/organizations/${organizationId}/members`)
      .set('Authorization', `Bearer ${creatorToken}`);

    expect(membersResponse.status).toBe(200);
    expect(membersResponse.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: creator.email }),
      ]),
    );

    const permissionsResponse = await request(app.getHttpServer())
      .get(`/api/v1/organizations/${organizationId}/permissions`)
      .set('Authorization', `Bearer ${creatorToken}`);

    expect(permissionsResponse.status).toBe(200);
  });

  it('no relaja la restricción para quien no pertenece a la organización', async () => {
    const creatorToken = await tokenFor(creator);
    const outsiderToken = await tokenFor(outsider);

    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${creatorToken}`)
      .set('X-Account-Id', creatorPersonalAccount.id)
      .send({
        name: 'Organización E2E Ajena',
        organizationName: 'Organización E2E Ajena S.A. de C.V.',
      });

    expect(createResponse.status).toBe(201);
    const organizationId: string = createResponse.body.data.organizationId;
    createdOrganizationIds.push(organizationId);

    const membersResponse = await request(app.getHttpServer())
      .get(`/api/v1/organizations/${organizationId}/members`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(membersResponse.status).toBe(403);
  });
});
