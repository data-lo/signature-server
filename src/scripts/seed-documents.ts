import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { UserEntity } from '../user/entities/user.entity';
import { PersonalInformationEntity } from '../user/entities/personal-information.entity';
import { DocumentEntity } from '../document/entities/document.entity';
import { CollaboratorEntity } from '../document/entities/collaborator.entity';
import { AccountEntity } from '../account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from '../account/enums/account-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../document/enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../document/enum/signee-status.enum';
import { UserRoles } from '../user/enums/user-roles';

/**
 * Puebla la base de datos con documentos de prueba (uno por cada estatus posible,
 * más variantes de "es tu turno" / "no es tu turno") para poder ejercitar en el
 * front cada filtro de la tabla de documentos (nombre, participante, estatus,
 * fecha de creación, fecha de firma y "solo mi turno") tanto por separado como
 * combinados. Se puede correr varias veces: no duplica documentos ya sembrados
 * (se identifican por su nombre de archivo, todos con el prefijo "[QA]").
 */

const QA_PREFIX = '[QA]';

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function fakeHash(): string {
  return randomBytes(32).toString('hex');
}

interface SeedUserSpec {
  email: string;
  firstName: string;
  lastName: string;
  position: string;
  nationalId: string;
}

const SEED_USERS: SeedUserSpec[] = [
  {
    email: 'ana.torres.qa@example.com',
    firstName: 'ANA',
    lastName: 'TORRES',
    position: 'CONTADORA',
    nationalId: 'TOAA900101MDFRRN01',
  },
  {
    email: 'luis.fernandez.qa@example.com',
    firstName: 'LUIS',
    lastName: 'FERNANDEZ',
    position: 'ABOGADO',
    nationalId: 'FELU880202HDFRRS02',
  },
];

const PRIMARY_TEST_EMAIL = 'manuel.balderrama@data-lo.com';

async function upsertUser(
  dataSource: DataSource,
  spec: SeedUserSpec,
): Promise<UserEntity> {
  const userRepository = dataSource.getRepository(UserEntity);
  const existing = await userRepository.findOne({
    where: { email: spec.email },
  });
  if (existing) return existing;

  const personalInformationRepository = dataSource.getRepository(
    PersonalInformationEntity,
  );
  const personalInformation = await personalInformationRepository.save(
    personalInformationRepository.create({
      name: spec.firstName,
      lastName: spec.lastName,
      curp: spec.nationalId,
    }),
  );

  const password = await bcrypt.hash('Password123!', 10);

  return userRepository.save(
    userRepository.create({
      firstName: spec.firstName,
      lastName: spec.lastName,
      email: spec.email,
      position: spec.position,
      roles: [UserRoles.SIGNER],
      nationalId: spec.nationalId,
      password,
      personalInformationId: personalInformation.id,
    }),
  );
}

interface ParticipantSpec {
  user: UserEntity;
  role: COLABORATOR_TYPE_ENUM;
  status: SIGNEE_STATUS_ENUM;
  signOrder: number;
  signedAt?: Date;
  rejectionReason?: string;
}

interface DocumentSpec {
  fileName: string;
  status: DOCUMENT_STATUS_ENUM;
  createdBy: UserEntity;
  createdAt: Date;
  signedAt?: Date;
  rejectedAt?: Date;
  cancelledAt?: Date;
  participants: ParticipantSpec[];
}

/** Busca la cuenta PERSONAL de un usuario (Account es una fila por usuario×contexto desde la Fase 5 — ver plan de migración ER-V2). */
async function findPersonalAccountId(
  dataSource: DataSource,
  userId: string,
): Promise<string> {
  const accountRepository = dataSource.getRepository(AccountEntity);
  const personalAccount = await accountRepository.findOne({
    where: { userId, accountType: ACCOUNT_TYPE_ENUM.PERSONAL },
  });

  if (!personalAccount) {
    throw new Error(
      `No se encontró una cuenta PERSONAL para el usuario ${userId}. Los documentos de prueba necesitan account_id.`,
    );
  }

  return personalAccount.id;
}

async function upsertDocument(
  dataSource: DataSource,
  spec: DocumentSpec,
  accountId: string,
) {
  const documentRepository = dataSource.getRepository(DocumentEntity);
  const collaboratorRepository = dataSource.getRepository(CollaboratorEntity);

  const existing = await documentRepository.findOne({
    where: { fileName: spec.fileName, createdBy: spec.createdBy.id },
  });
  if (existing) {
    console.log(`  ↳ ya existe, se omite: ${spec.fileName}`);
    return existing;
  }

  const signerSpecs = spec.participants.filter(
    (p) => p.role === COLABORATOR_TYPE_ENUM.SIGNER,
  );
  const completedSignerSpecs = signerSpecs.filter(
    (p) => p.status === SIGNEE_STATUS_ENUM.SIGNED,
  );

  const document = await documentRepository.save(
    documentRepository.create({
      objectKey: `qa-seed/${randomUUID()}.pdf`,
      fileName: spec.fileName,
      fileType: 'application/pdf',
      totalPages: 1,
      ipAddress: '127.0.0.1',
      originalHash: fakeHash(),
      signedHash: spec.signedAt ? fakeHash() : null,
      status: spec.status,
      signatureCoordinates: null,
      createdBy: spec.createdBy.id,
      accountId,
      totalSigners: signerSpecs.length,
      completedSignersCount: completedSignerSpecs.length,
    }),
  );

  // Los timestamps de auditoría (createdAt/signedAt/rejectedAt/cancelledAt) se
  // fuerzan con un UPDATE aparte porque @CreateDateColumn/@UpdateDateColumn
  // sobrescriben el valor asignado en el insert inicial.
  await documentRepository.update(document.id, {
    createdAt: spec.createdAt,
    signedAt: spec.signedAt ?? null,
    rejectedAt: spec.rejectedAt ?? null,
    cancelledAt: spec.cancelledAt ?? null,
  });

  await collaboratorRepository.save(
    spec.participants.map((p) =>
      collaboratorRepository.create({
        documentId: document.id,
        userId: p.user.id,
        colaboratorType: p.role,
        status: p.status,
        signingOrder: p.signOrder,
        signedAt: p.signedAt ?? null,
        cancellationReason: p.rejectionReason ?? null,
        ipAddress: '127.0.0.1',
      }),
    ),
  );

  console.log(`  ✔ creado: ${spec.fileName} (${spec.status})`);
  return document;
}

async function main() {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.POSTGRES_DB_URL,
    // Glob doble extensión: en dev corre vía ts-node sobre src/**/*.entity.ts, en
    // Docker/producción corre con `node` directo sobre dist/**/*.entity.js (ver DoD del
    // ticket de seeding post-build) — __dirname apunta a la carpeta real en ambos casos, así
    // que un solo glob cubre los dos entornos sin necesidad de una variable de entorno aparte.
    entities: [join(__dirname, '..', '**', '*.entity{.ts,.js}')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  console.log('Conectado a la base de datos.');

  const userRepository = dataSource.getRepository(UserEntity);
  const primaryUser = await userRepository.findOne({
    where: { email: PRIMARY_TEST_EMAIL },
  });

  if (!primaryUser) {
    throw new Error(
      `No se encontró el usuario de prueba principal '${PRIMARY_TEST_EMAIL}'. ` +
        'Crea una cuenta con ese correo (o ajusta PRIMARY_TEST_EMAIL en este script) antes de sembrar documentos.',
    );
  }

  console.log(`Usuario principal de pruebas: ${primaryUser.email}`);
  const primaryAccountId = await findPersonalAccountId(
    dataSource,
    primaryUser.id,
  );

  console.log('Creando/verificando usuarios participantes de prueba...');
  const [ana, luis] = await Promise.all(
    SEED_USERS.map((spec) => upsertUser(dataSource, spec)),
  );

  const S = SIGNEE_STATUS_ENUM;
  const R = COLABORATOR_TYPE_ENUM;

  const documents: DocumentSpec[] = [
    {
      fileName: `${QA_PREFIX} Creado - Propuesta Comercial 2026.pdf`,
      status: DOCUMENT_STATUS_ENUM.CREATED,
      createdBy: primaryUser,
      createdAt: daysAgo(25),
      participants: [
        {
          user: ana,
          role: R.SIGNER,
          status: S.PENDING,
          signOrder: 0,
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Pendiente (no es tu turno) - Contrato de Arrendamiento.pdf`,
      status: DOCUMENT_STATUS_ENUM.PENDING,
      createdBy: primaryUser,
      createdAt: daysAgo(20),
      participants: [
        { user: ana, role: R.SIGNER, status: S.PENDING, signOrder: 0 },
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.PENDING,
          signOrder: 1,
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Pendiente (tu turno) - Convenio de Confidencialidad NDA.pdf`,
      status: DOCUMENT_STATUS_ENUM.PENDING,
      createdBy: primaryUser,
      createdAt: daysAgo(15),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.PENDING,
          signOrder: 0,
        },
        { user: luis, role: R.SIGNER, status: S.PENDING, signOrder: 1 },
      ],
    },
    {
      fileName: `${QA_PREFIX} Firmado - Factura de Servicios Enero.pdf`,
      status: DOCUMENT_STATUS_ENUM.SIGNED,
      createdBy: primaryUser,
      createdAt: daysAgo(40),
      signedAt: daysAgo(35),
      participants: [
        {
          user: ana,
          role: R.SIGNER,
          status: S.SIGNED,
          signOrder: 0,
          signedAt: daysAgo(36),
        },
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.SIGNED,
          signOrder: 1,
          signedAt: daysAgo(35),
        },
        { user: luis, role: R.WATCHER, status: S.PENDING, signOrder: 0 },
      ],
    },
    {
      fileName: `${QA_PREFIX} Firmado - Acuerdo de Colaboración.pdf`,
      status: DOCUMENT_STATUS_ENUM.SIGNED,
      createdBy: primaryUser,
      createdAt: daysAgo(10),
      signedAt: daysAgo(8),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.SIGNED,
          signOrder: 0,
          signedAt: daysAgo(8),
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Rechazado - Orden de Compra 552.pdf`,
      status: DOCUMENT_STATUS_ENUM.REJECTED,
      createdBy: primaryUser,
      createdAt: daysAgo(18),
      rejectedAt: daysAgo(17),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.REJECTED,
          signOrder: 0,
          rejectionReason: 'No corresponde con lo acordado.',
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Expirado - Póliza de Seguro.pdf`,
      status: DOCUMENT_STATUS_ENUM.EXPIRED,
      createdBy: primaryUser,
      createdAt: daysAgo(60),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.PENDING,
          signOrder: 0,
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Cancelación pendiente - Contrato de Renta de Equipo.pdf`,
      status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
      createdBy: primaryUser,
      createdAt: daysAgo(50),
      signedAt: daysAgo(45),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.SIGNED,
          signOrder: 0,
          signedAt: daysAgo(45),
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Cancelado - Addendum Contractual.pdf`,
      status: DOCUMENT_STATUS_ENUM.CANCELLED,
      createdBy: primaryUser,
      createdAt: daysAgo(70),
      signedAt: daysAgo(65),
      cancelledAt: daysAgo(60),
      participants: [
        {
          user: primaryUser,
          role: R.SIGNER,
          status: S.SIGNED,
          signOrder: 0,
          signedAt: daysAgo(65),
        },
      ],
    },
    {
      fileName: `${QA_PREFIX} Creado por ti (para terceros) - Informe de Auditoría.pdf`,
      status: DOCUMENT_STATUS_ENUM.PENDING,
      createdBy: primaryUser,
      createdAt: daysAgo(5),
      participants: [
        { user: ana, role: R.SIGNER, status: S.PENDING, signOrder: 0 },
        { user: luis, role: R.WATCHER, status: S.PENDING, signOrder: 0 },
      ],
    },
  ];

  console.log('Creando documentos de prueba...');
  for (const spec of documents) {
    await upsertDocument(dataSource, spec, primaryAccountId);
  }

  await dataSource.destroy();
  console.log('Listo. Base de datos poblada con documentos de prueba.');
}

main().catch((error) => {
  console.error('Error sembrando documentos de prueba:', error);
  process.exit(1);
});
