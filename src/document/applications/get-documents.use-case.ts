import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { MinioService } from 'src/common/minio/minio.service';
import { UserService } from 'src/user/user.service';

import { GetDocumentsQueryDto } from '../dto/get-documents-query.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import {
  DOCUMENT_SORT_FIELD_ENUM,
  SORT_DIRECTION_ENUM,
} from '../enum/document-sort-field.enum';
import { DOCUMENT_VIEW_ENUM } from '../enum/document-view.enum';
import { DOCUMENT_PARTICIPATION_ENUM } from '../enum/document-participation.enum';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { DocumentService } from '../document.service';

/** Lo que el caso de uso necesita: quién pregunta, desde qué cuenta, y qué quiere ver. */
export interface GetDocumentsParams {
  /** Usuario autenticado. De él sale también el correo con el que se busca su participación. */
  userId: string;
  /** Cuenta activa (`X-Account-Id`): acota lo visible al contexto en el que está trabajando. */
  accountId: string;
  /**
   * Recorte, búsqueda, orden y paginación.
   *
   * `view` escoge un subconjunto de lo visible y NUNCA lo amplía; el acceso lo decide la cuenta
   * activa, no el filtro.
   */
  filters: GetDocumentsQueryDto;
}

export interface DocumentsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Los roles que tienen algo que HACER con un documento.
 *
 * `WATCHER` queda fuera: un observador recibe copia y puede consultarlo, pero no se le pide
 * nada, así que un documento nunca "requiere su firma o revisión" y meterlo en esa vista sería
 * darle una tarea que no existe.
 */
const ACTING_COLLABORATOR_TYPES = [
  COLABORATOR_TYPE_ENUM.SIGNER,
  COLABORATOR_TYPE_ENUM.REVIEWER,
];

/**
 * De qué campo del enum sale cada columna del `ORDER BY`.
 *
 * El mapa es lo que convierte la lista cerrada del DTO en SQL. Es la única forma en que un valor
 * del cliente llega al ordenamiento, y llega como CLAVE de este objeto, nunca como texto: el
 * `ORDER BY` no admite parámetros preparados, así que lo que se interpola tiene que salir de acá.
 */
const SORT_COLUMNS: Record<DOCUMENT_SORT_FIELD_ENUM, string> = {
  [DOCUMENT_SORT_FIELD_ENUM.CREATED_AT]: 'document.createdAt',
  [DOCUMENT_SORT_FIELD_ENUM.SIGNED_AT]: 'document.signedAt',
  [DOCUMENT_SORT_FIELD_ENUM.FILE_NAME]: 'document.fileName',
  [DOCUMENT_SORT_FIELD_ENUM.STATUS]: 'document.status',
};

/**
 * Lista los documentos que la cuenta activa puede ver, con búsqueda, recorte, orden y paginación.
 *
 * @remarks
 * Flujo:
 *
 * 1. Exige el header de cuenta activa y comprueba que quien pregunta sea miembro de ella, antes
 *    de mirar un solo filtro.
 * 2. Valida los rangos de fecha.
 * 3. Resuelve el correo del usuario en el servidor, que es con el que se busca su participación.
 * 4. Aplica la VISIBILIDAD: cuenta activa, lo que creó y aquello en lo que participa.
 * 5. Aplica el `view` pedido y excluye lo que este usuario archivó.
 * 6. Suma los filtros opcionales: id, estados, búsqueda, participante y rangos de fecha.
 * 7. Pagina, ordena con desempate estable y arma la respuesta; opcionalmente firma URLs de MinIO.
 *
 * **`view` no decide el acceso.** El orden de los pasos 4 y 5 es la garantía: primero se acota lo
 * que el usuario puede ver y sólo después se escoge un subconjunto. Un `view` distinto no puede
 * ampliar lo visible; en el peor caso lo deja vacío.
 *
 * Sustituye a las tres consultas que se repartían la bandeja, cada una con su propia receta de
 * parámetros. Aquello dejaba la definición de cada sección en el cliente —el servidor no sabía
 * qué era "por firmar"—, hacía las tres incombinables entre sí y ninguna se podía ordenar.
 */
@Injectable()
export class GetDocumentsUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly accountMemberService: AccountMemberService,
    private readonly userService: UserService,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param params Quién pregunta, desde qué cuenta y con qué filtros.
   * @returns La página de documentos con su paginación.
   * @throws {BadRequestException} Cuando falta el header de cuenta activa o un rango de fechas
   *   termina antes de empezar.
   * @throws {ForbiddenException} Cuando el usuario no es miembro activo de la cuenta.
   */
  async execute({ userId, accountId, filters }: GetDocumentsParams) {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }

    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      userId,
      accountId,
    );

    const {
      view = DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE,
      search,
      statuses,
      participant,
      createdFrom,
      createdTo,
      signedFrom,
      signedTo,
      sortBy = DOCUMENT_SORT_FIELD_ENUM.CREATED_AT,
      sortDirection = SORT_DIRECTION_ENUM.DESC,
      page = 1,
      limit = 25,
      id,
      withUrl,
    } = filters;

    this.assertValidDateRange(createdFrom, createdTo, 'creación');
    this.assertValidDateRange(signedFrom, signedTo, 'firma');

    /**
     * El correo sale del servidor y no de la query: pedírselo al cliente sería confiarle de quién
     * es la bandeja. Hace falta porque un firmante invitado por correo no tiene cuenta vinculada
     * todavía, así que su fila en `collaborators` sólo tiene el email.
     *
     * En minúsculas: `users.email` se guarda normalizado, pero `collaborators.email` conserva lo
     * que tecleó quien invitó.
     */
    const caller = await this.userService.findOne(userId);
    const callerEmail = caller.email?.toLowerCase() ?? null;

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      // El RFC vive en `personal_information`, y el listado lo muestra bajo el nombre del creador.
      .leftJoinAndSelect(
        'requester.personalInformation',
        'requesterPersonalInfo',
      )
      .leftJoinAndSelect('document.collaborators', 'collaborator')
      .leftJoinAndSelect('collaborator.account', 'collaboratorAccount')
      .leftJoinAndSelect('collaboratorAccount.user', 'collaboratorUser')
      .orderBy(SORT_COLUMNS[sortBy], sortDirection)
      // Desempate estable: sin él, un documento se repite entre páginas mientras otro no sale.
      .addOrderBy('document.id', sortDirection)
      .skip((page - 1) * limit)
      .take(limit);

    this.applyVisibility(qb, { userId, callerEmail, activeAccount, accountId });
    this.applyView(qb, view, userId);
    this.excludeArchived(qb, userId);

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (statuses?.length) {
      qb.andWhere('document.status IN (:...statuses)', { statuses });
    }

    if (search) {
      // Una caja para nombre y participantes: es lo que la persona tiene en la cabeza al buscar.
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('document.fileName ILIKE :search')
            .orWhere(this.participantMatchSubquery('search'));
        }),
        { search: `%${search}%` },
      );
    }

    if (participant) {
      qb.andWhere(this.participantMatchSubquery('participant'), {
        participant: `%${participant}%`,
      });
    }

    if (createdFrom) {
      qb.andWhere('document.createdAt >= :createdFrom', {
        createdFrom: new Date(createdFrom),
      });
    }

    if (createdTo) {
      qb.andWhere('document.createdAt <= :createdTo', {
        createdTo: new Date(createdTo),
      });
    }

    if (signedFrom) {
      qb.andWhere('document.signedAt >= :signedFrom', {
        signedFrom: new Date(signedFrom),
      });
    }

    if (signedTo) {
      qb.andWhere('document.signedAt <= :signedTo', {
        signedTo: new Date(signedTo),
      });
    }

    const [documents, total] = await qb.getManyAndCount();

    const items = await Promise.all(
      documents.map(async (doc) => {
        const byType = (type: COLABORATOR_TYPE_ENUM) =>
          (doc.collaborators ?? [])
            .filter((c) => c.colaboratorType === type)
            .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
            .map(collaboratorDisplayName);

        const base = {
          id: doc.id,
          fileName: doc.fileName,
          fileType: doc.fileType,
          signers: byType(COLABORATOR_TYPE_ENUM.SIGNER),
          watchers: byType(COLABORATOR_TYPE_ENUM.WATCHER),
          reviewers: byType(COLABORATOR_TYPE_ENUM.REVIEWER),
          creator: `${doc.requestedBy.firstName} ${doc.requestedBy.lastName}`,
          creatorRfc: doc.requestedBy.personalInformation?.rfc ?? null,
          totalPages: doc.totalPages,
          status: doc.status,
          signatureType: this.documentService.resolveDocumentSignatureType(
            doc.collaborators,
          ),
          /**
           * Qué papel juega el usuario en ESTE documento, resuelto en el servidor.
           *
           * La columna "Participación" del listado unificado lo necesita en cada fila, y antes no
           * hacía falta porque la sección ya lo decía: en "Por firmar" todo requería mi firma y
           * en "Enviados para firma" todo lo había mandado yo. Sin secciones, cada fila tiene que
           * explicarse sola.
           */
          participation: this.resolveParticipation(doc, userId, callerEmail),
          createdAt: doc.createdAt,
          /**
           * Fecha en que el documento quedó firmado por completo (`document.signedAt`, que solo
           * se fija cuando la última firma cierra el flujo), no la de una firma individual. Null
           * mientras eso no ocurra: el listado lo muestra como "No disponible".
           */
          signedAt: doc.signedAt ?? null,
        };

        if (!withUrl) {
          return base;
        }

        const bucket = this.documentService.resolveDocumentBucket(doc);
        const { secureUrl, expiresIn } = await this.minioService.getFile(
          doc.objectKey,
          bucket,
        );

        return { ...base, secureUrl, expiresIn };
      }),
    );

    const pagination: DocumentsPagination = {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };

    return { items, pagination };
  }

  /**
   * Lo que este usuario puede ver, y que ningún filtro puede ensanchar.
   *
   * Son tres caminos y basta uno: el documento pertenece a la cuenta desde la que mira (o a su
   * organización), lo creó él, o participa en él. El tercero no sobra — casi ningún documento que
   * me toca firmar pertenece a MI cuenta, sino a la de quien lo mandó — y por eso las tres
   * condiciones van en un `OR` dentro de un mismo paréntesis: sueltas, el `AND` de cualquier
   * filtro posterior se mezclaría con ellas y el resultado dejaría de significar lo mismo.
   */
  private applyVisibility(
    qb: SelectQueryBuilder<DocumentEntity>,
    context: {
      userId: string;
      callerEmail: string | null;
      activeAccount: { organizationId?: string | null };
      accountId: string;
    },
  ): void {
    const { userId, callerEmail, activeAccount, accountId } = context;

    qb.andWhere(
      new Brackets((where) => {
        if (activeAccount.organizationId) {
          where.where('document.organizationId = :organizationId', {
            organizationId: activeAccount.organizationId,
          });
        } else {
          where.where('document.accountId = :accountId', { accountId });
        }

        where
          .orWhere('document.createdBy = :userId', { userId })
          .orWhere(this.callerIsParticipantSubquery(), {
            userId,
            callerEmail,
          });
      }),
    );
  }

  /** Recorta lo visible al subconjunto que pide `view`. Nunca amplía: sólo agrega condiciones. */
  private applyView(
    qb: SelectQueryBuilder<DocumentEntity>,
    view: DOCUMENT_VIEW_ENUM,
    userId: string,
  ): void {
    switch (view) {
      case DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE:
        /**
         * Dos condiciones, y las dos hacen falta: el documento sigue abierto Y mi respuesta sigue
         * pendiente. Sin la primera, un documento cancelado con mi firma sin dar seguiría
         * pidiéndome algo que ya no se puede hacer; sin la segunda, los que ya firmé volverían a
         * aparecer como tarea.
         */
        qb.andWhere('document.status = :pendingStatus', {
          pendingStatus: DOCUMENT_STATUS_ENUM.PENDING,
        }).andWhere(
          `document.id IN (
            SELECT c.document_id FROM collaborators c
            LEFT JOIN accounts a ON a.id = c.account_id
            LEFT JOIN users u ON u.id = a.user_id
            WHERE (u.id = :userId OR LOWER(c.email) = :callerEmail)
              AND c.colaborator_type IN (:...actingTypes)
              AND c.status = :pendingSigneeStatus
          )`,
          {
            actingTypes: ACTING_COLLABORATOR_TYPES,
            pendingSigneeStatus: SIGNEE_STATUS_ENUM.PENDING,
          },
        );
        return;

      case DOCUMENT_VIEW_ENUM.CREATED_BY_ME:
        qb.andWhere('document.createdBy = :userId', { userId });
        return;

      case DOCUMENT_VIEW_ENUM.COMPLETED:
        qb.andWhere('document.status = :signedStatus', {
          signedStatus: DOCUMENT_STATUS_ENUM.SIGNED,
        });
        return;

      case DOCUMENT_VIEW_ENUM.ALL:
      default:
        return;
    }
  }

  /**
   * Fuera lo que ESTE usuario archivó.
   *
   * `leftJoin` y no `innerJoin`: la mayoría de los documentos no tienen preferencia de nadie, y
   * un `INNER JOIN` vaciaría el listado entero. Sin fila, `archivedAt` es `NULL` y el documento
   * pasa el filtro — que es exactamente lo que significa "no he dicho nada sobre este documento".
   *
   * El `user_id` va en la condición del JOIN y no en el `WHERE`: puesto abajo, un documento
   * archivado por OTRO participante traería su fila y desaparecería también de mi listado, con lo
   * que archivar dejaría de ser una decisión personal.
   */
  private excludeArchived(
    qb: SelectQueryBuilder<DocumentEntity>,
    userId: string,
  ): void {
    qb.leftJoin(
      DocumentUserPreferenceEntity,
      'myPreference',
      'myPreference.documentId = document.id AND myPreference.userId = :preferenceUserId',
      { preferenceUserId: userId },
    ).andWhere('myPreference.archivedAt IS NULL');
  }

  /**
   * "Soy participante de este documento", por cuenta vinculada o por el correo de la invitación.
   *
   * Los dos caminos son necesarios: un firmante invitado por correo no tiene `account_id` hasta
   * que algo lo vincula —y eso ocurre al firmar, rechazar o pedir el código, es decir, nunca
   * antes de ver esta lista— así que emparejar sólo por cuenta lo dejaría sin ver el documento
   * que tiene que firmar.
   */
  private callerIsParticipantSubquery(): string {
    return `document.id IN (
      SELECT c.document_id FROM collaborators c
      LEFT JOIN accounts a ON a.id = c.account_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE u.id = :userId OR LOWER(c.email) = :callerEmail
    )`;
  }

  /** Documentos con algún participante cuyo nombre o correo case con `:<paramName>`. */
  private participantMatchSubquery(paramName: string): string {
    return `document.id IN (
      SELECT c.document_id FROM collaborators c
      LEFT JOIN accounts a ON a.id = c.account_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE u.first_name ILIKE :${paramName}
         OR u.last_name ILIKE :${paramName}
         OR u.email ILIKE :${paramName}
         OR c.email ILIKE :${paramName}
    )`;
  }

  /**
   * Qué es el usuario dentro de este documento, con un solo valor por fila.
   *
   * El orden importa cuando alguien es varias cosas a la vez —crear un documento y firmarlo uno
   * mismo es corriente—: gana lo que le pide una acción, porque es lo que explica por qué esa
   * fila está en su lista. Se resuelve sobre los colaboradores YA cargados por el join, sin una
   * consulta extra por documento.
   */
  private resolveParticipation(
    document: DocumentEntity,
    userId: string,
    callerEmail: string | null,
  ): DOCUMENT_PARTICIPATION_ENUM {
    const mine = (document.collaborators ?? []).filter(
      (c) =>
        c.account?.userId === userId ||
        (Boolean(c.email) && c.email?.toLowerCase() === callerEmail),
    );

    const owesAnswer = mine.some(
      (c) =>
        ACTING_COLLABORATOR_TYPES.includes(c.colaboratorType) &&
        c.status === SIGNEE_STATUS_ENUM.PENDING &&
        document.status === DOCUMENT_STATUS_ENUM.PENDING,
    );
    if (owesAnswer) return DOCUMENT_PARTICIPATION_ENUM.REQUIRES_MY_SIGNATURE;

    if (document.createdBy === userId) {
      return DOCUMENT_PARTICIPATION_ENUM.CREATED_BY_ME;
    }

    return DOCUMENT_PARTICIPATION_ENUM.PARTICIPANT;
  }

  /**
   * Un rango al revés (`desde` posterior a `hasta`) no devuelve nada, y en silencio: la lista
   * sale vacía y quien la mira no tiene cómo saber si es que no hay documentos o es que tecleó
   * las fechas cambiadas. Vale más un 400 que lo diga.
   */
  private assertValidDateRange(
    from: string | undefined,
    to: string | undefined,
    label: string,
  ): void {
    if (!from || !to) return;

    if (new Date(from).getTime() > new Date(to).getTime()) {
      throw new BadRequestException(
        `El rango de fechas de ${label} está invertido: la fecha inicial (${from}) es posterior a la final (${to})`,
      );
    }
  }
}
