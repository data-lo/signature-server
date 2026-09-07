import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { DocumentEntity } from '../entities/document.entity';

/**
 * Lo que UNA persona decide sobre UN documento, sin tocar el documento.
 *
 * **Por qué una tabla aparte y no una columna en `documents`.** Un documento lo comparten su
 * creador, sus firmantes y sus observadores; una bandera en la fila del documento sería una
 * decisión de todos ellos a la vez. Que alguien archive un contrato que ya firmó no puede
 * esconderlo de quien todavía tiene que firmarlo — y con un `is_archived` global eso es
 * exactamente lo que pasaría. Por eso la preferencia cuelga del PAR documento-usuario: cada quien
 * ordena su bandeja sin mover la de nadie.
 *
 * **Es la tabla de preferencias, no la tabla de archivado.** `archived_at` es la primera columna
 * que la habita, pero el nombre y la forma están pensados para lo que viene detrás —favoritos,
 * última consulta, etiquetas personales—: todas son datos privados del mismo par, y darle a cada
 * una su propia tabla acabaría en cuatro `LEFT JOIN` para pintar una fila de la bandeja. Cada
 * preferencia nueva es una columna nullable acá, y `null` significa siempre "esta persona no ha
 * dicho nada al respecto".
 *
 * **La fila puede no existir, y eso es un estado válido**: la mayoría de los documentos no tienen
 * preferencia de nadie. Quien consulte tiene que tratar "sin fila" igual que "todos los campos en
 * null", y por eso las lecturas van por `LEFT JOIN` y no por `INNER JOIN`. Crear la fila al abrir
 * un documento —para "tenerla ya"— llenaría la tabla de filas vacías, una por cada documento que
 * alguien sólo miró.
 *
 * Esta historia crea el modelo y nada más: no hay endpoints, ni filtros, ni lógica de archivado.
 */
@Entity('document_user_preferences')
/**
 * Una sola preferencia por par documento-usuario.
 *
 * Es lo que convierte "no dupliques" en una garantía del motor: sin ella, dos peticiones
 * simultáneas —dos pestañas, un doble clic en "Archivar"— insertarían dos filas y la lectura
 * siguiente tendría que decidir cuál de las dos manda. Con el índice, la segunda choca y el
 * llamador la resuelve como lo que es: la misma preferencia, ya guardada.
 *
 * Sirve además de índice de búsqueda para "la preferencia de ESTE usuario sobre ESTE documento",
 * que es la consulta que hará la vista de detalle.
 */
@Unique('UQ_document_user_preferences_document_user', ['documentId', 'userId'])
/**
 * La bandeja de una persona: sus documentos archivados, o los que no lo están.
 *
 * Lleva `archived_at` como segunda columna a propósito. La consulta que viene es "los documentos
 * de este usuario donde `archived_at` es (o no es) nulo", y con un índice sólo por `user_id`
 * Postgres tendría que leer todas sus filas para descartar las demás. `user_id` va primero porque
 * es la igualdad; `archived_at`, después, porque es el filtro.
 */
@Index('IDX_document_user_preferences_user_archived', ['userId', 'archivedAt'])
/**
 * El camino inverso: todas las preferencias de un documento.
 *
 * No lo cubre el índice único —que empieza por `documentId` y serviría igual— pero ése existe
 * para garantizar unicidad, y apoyarse en su forma ataría una consulta a una restricción que
 * podría cambiar de columnas. Es además el índice que usa el `ON DELETE CASCADE` al borrar un
 * documento con muchas preferencias.
 */
@Index('IDX_document_user_preferences_document', ['documentId'])
export class DocumentUserPreferenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  /**
   * `CASCADE`: la preferencia no sobrevive al documento. No hay nada que conservar —no es
   * evidencia de nada, es cómo alguien tenía ordenada su bandeja— y una fila apuntando a un
   * documento borrado sólo puede estorbar a la consulta que la encuentre.
   */
  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ name: 'user_id' })
  userId: string;

  /**
   * Apunta a `users` y no a `accounts`, al revés que `CollaboratorEntity`.
   *
   * No es una inconsistencia: aquél identifica a un PARTICIPANTE del documento —un rol dentro de
   * un contexto de facturación, que puede ser una organización— y esto describe a la PERSONA que
   * mira su bandeja. La misma persona que pertenece a dos organizaciones tiene una sola bandeja,
   * y colgar la preferencia de la cuenta le archivaría el documento en un contexto y no en el
   * otro.
   */
  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  /**
   * Cuándo archivó este usuario el documento, o `null` si no lo ha archivado.
   *
   * **Fecha y no booleano.** Cuesta lo mismo y responde una pregunta más —desde cuándo—, que es
   * la que hace falta para ordenar la vista de archivados y para explicar qué pasó cuando alguien
   * no encuentra un documento. Desarchivar es volver a `null`: se pierde la fecha anterior, y eso
   * es correcto mientras nadie pida el historial de archivado; el día que se pida, será su propia
   * tabla y no un segundo campo acá.
   */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
