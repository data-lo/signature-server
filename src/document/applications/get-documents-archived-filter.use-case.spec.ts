import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AccountMemberService } from 'src/account/account-member.service';
import { MinioService } from 'src/common/minio/minio.service';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { UserService } from 'src/user/user.service';

import { GetDocumentsUseCase } from './get-documents.use-case';
import { DocumentService } from '../document.service';
import { GetDocumentsQueryDto } from '../dto/get-documents-query.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DOCUMENT_VIEW_ENUM } from '../enum/document-view.enum';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';

/**
 * Query builder de TypeORM doblado: registra cada llamada y se devuelve a sí mismo para que el
 * caso de uso pueda encadenar. `getManyAndCount` responde vacío: estas pruebas miran QUÉ se
 * consulta, no cómo se arma cada fila.
 */
function createMockQueryBuilder() {
  const qb: Record<string, jest.Mock> = {};
  [
    'where',
    'andWhere',
    'orWhere',
    'leftJoin',
    'leftJoinAndSelect',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ].forEach((method) => {
    qb[method] = jest.fn().mockReturnValue(qb);
  });
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
}

/** Condiciones en texto plano que recibió `andWhere` (las de `Brackets` se omiten). */
function plainConditions(qb: ReturnType<typeof createMockQueryBuilder>) {
  return qb.andWhere.mock.calls
    .map(([condition]: [unknown]) => condition)
    .filter((condition): condition is string => typeof condition === 'string');
}

/**
 * Historia "Agregar filtro de documentos archivados".
 *
 * Vive en su propio archivo y no junto al resto de las pruebas del listado
 * (`document.use-cases.spec.ts`) porque aquél no compila hoy en `development`, y el filtro nuevo
 * necesita pruebas que corran.
 */
describe('GetDocumentsUseCase — filtro "Archivados"', () => {
  let useCase: GetDocumentsUseCase;
  let documentRepository: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    documentRepository = { createQueryBuilder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetDocumentsUseCase,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        { provide: MinioService, useValue: { getFile: jest.fn() } },
        {
          provide: AccountMemberService,
          useValue: {
            assertIsActiveMember: jest
              .fn()
              .mockResolvedValue({ id: 'account-1', organizationId: null }),
          },
        },
        {
          provide: UserService,
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'user-1', email: 'ana@correo.com' }),
          },
        },
        { provide: DocumentService, useValue: {} },
      ],
    }).compile();

    useCase = module.get(GetDocumentsUseCase);
  });

  function list(filters: Partial<GetDocumentsQueryDto> = {}) {
    const qb = createMockQueryBuilder();
    documentRepository.createQueryBuilder.mockReturnValue(qb);
    const response = useCase.execute({
      userId: 'user-1',
      accountId: 'account-1',
      scopes: [PERMISSION_SCOPE_ENUM.OWN],
      filters: { page: 1, limit: 25, ...filters } as GetDocumentsQueryDto,
    });
    return { qb, response };
  }

  /** Sin el filtro, todo sigue como antes: lo archivado queda fuera. */
  it('sin el filtro excluye lo que el usuario archivó', async () => {
    const { qb, response } = list();
    await response;

    expect(plainConditions(qb)).toContain('myPreference.archivedAt IS NULL');
    expect(plainConditions(qb)).not.toContain(
      'myPreference.archivedAt IS NOT NULL',
    );
  });

  it('con archived=true lista sólo lo que el usuario archivó', async () => {
    const { qb, response } = list({ archived: true });
    await response;

    expect(plainConditions(qb)).toContain(
      'myPreference.archivedAt IS NOT NULL',
    );
    expect(plainConditions(qb)).not.toContain(
      'myPreference.archivedAt IS NULL',
    );
  });

  /**
   * Archivar es personal: el usuario va en el `ON` del JOIN. Si estuviera en el `WHERE`, un
   * documento archivado por OTRO participante aparecería entre MIS archivados.
   */
  it('sólo cuentan las preferencias del usuario que consulta', async () => {
    const { qb, response } = list({ archived: true });
    await response;

    const [entity, alias, condition, parameters] = qb.leftJoin.mock.calls[0];
    expect(entity).toBe(DocumentUserPreferenceEntity);
    expect(alias).toBe('myPreference');
    expect(condition).toBe(
      'myPreference.documentId = document.id AND myPreference.userId = :preferenceUserId',
    );
    expect(parameters).toEqual({ preferenceUserId: 'user-1' });
  });

  /**
   * El filtro se suma a los demás en vez de reemplazarlos: el recorte de `view`, los estados, el
   * orden y la paginación siguen aplicándose igual.
   */
  it('se combina con view, estados, orden y paginación', async () => {
    const { qb, response } = list({
      archived: true,
      view: DOCUMENT_VIEW_ENUM.CREATED_BY_ME,
      statuses: [DOCUMENT_STATUS_ENUM.SIGNED],
      page: 3,
      limit: 10,
    });
    await response;

    const conditions = plainConditions(qb);
    expect(conditions).toContain('document.createdBy = :userId');
    expect(conditions).toContain('document.status IN (:...statuses)');
    expect(conditions).toContain('myPreference.archivedAt IS NOT NULL');
    expect(qb.orderBy).toHaveBeenCalled();
    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(10);
  });

  /**
   * No amplía el acceso: la visibilidad se aplica antes, así que un documento archivado que el
   * usuario ya no puede ver tampoco sale entre sus archivados.
   */
  it('se aplica después de la visibilidad', async () => {
    const { qb, response } = list({ archived: true });
    await response;

    const archiveCallIndex = qb.andWhere.mock.calls.findIndex(
      ([condition]: [unknown]) =>
        condition === 'myPreference.archivedAt IS NOT NULL',
    );
    const firstBracketsIndex = qb.andWhere.mock.calls.findIndex(
      ([condition]: [unknown]) => typeof condition !== 'string',
    );
    expect(firstBracketsIndex).toBeGreaterThan(-1);
    expect(firstBracketsIndex).toBeLessThan(archiveCallIndex);
  });

  it('sin archivados responde una página vacía, no un error', async () => {
    const { response } = list({ archived: true });

    await expect(response).resolves.toMatchObject({
      items: [],
      pagination: { page: 1, total: 0 },
    });
  });
});

describe('GetDocumentsQueryDto.archived', () => {
  async function parse(query: Record<string, unknown>) {
    const dto = plainToInstance(GetDocumentsQueryDto, query);
    const errors = await validate(dto);
    return { dto, errors };
  }

  it('llega de la query string como texto y se convierte a booleano', async () => {
    const { dto, errors } = await parse({ archived: 'true' });

    expect(errors).toHaveLength(0);
    expect(dto.archived).toBe(true);
  });

  it.each([[{}], [{ archived: 'false' }]])(
    'sin el parámetro o en "false" queda en false (%j)',
    async (query) => {
      const { dto, errors } = await parse(query);

      expect(errors).toHaveLength(0);
      expect(dto.archived).toBe(false);
    },
  );
});
