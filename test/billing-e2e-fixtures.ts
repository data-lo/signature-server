import { EntityManager, FindOperator } from 'typeorm';

/**
 * Repositorio en memoria para las pruebas e2e de facturación.
 *
 * Se sustituye la base de datos y NADA más: controladores, casos de uso, verificación de firma,
 * enrutado de eventos y servicios de dominio son los reales. La alternativa —una base de datos
 * de verdad— haría que estas pruebas dependieran de que el contenedor esté levantado y de que
 * las migraciones estén al día, y lo que se quiere cazar acá es el cableado HTTP (prefijo,
 * cuerpo crudo, códigos de estado), no el SQL, que ya cubren las migraciones.
 *
 * `where` se compara campo a campo por igualdad estricta, con dos añadidos que sí usan los
 * servicios bajo prueba: los operadores `IsNull`/`MoreThan` y el arreglo de condiciones, que en
 * TypeORM significa OR. `relations` se ignora a propósito: las filas de prueba ya vienen con su
 * relación embebida, igual que si TypeORM la hubiera resuelto.
 */
export interface InMemoryRepository<T extends { id?: string }> {
  rows: T[];
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  findOneBy: jest.Mock;
  update: jest.Mock;
  sum: jest.Mock;
}

let generatedIds = 0;

/**
 * Los operadores de TypeORM que usan los servicios bajo prueba, y sólo ésos.
 *
 * Se interpretan acá porque sin ellos `where: { remaining: MoreThan(0) }` se compararía por
 * igualdad estricta contra el objeto operador y no casaría NUNCA — una prueba que pasa por el
 * motivo equivocado, que es peor que una que falla. Un operador no contemplado revienta a
 * propósito: es la señal de que hay que enseñárselo a este fixture en vez de dejar que devuelva
 * `false` en silencio.
 */
function matchesOperator(value: unknown, operator: FindOperator<unknown>) {
  switch (operator.type) {
    case 'isNull':
      return value === null || value === undefined;
    case 'moreThan':
      return (
        value !== null &&
        value !== undefined &&
        (value as number) > (operator.value as number)
      );
    default:
      throw new Error(
        `El repositorio en memoria no sabe evaluar el operador ${operator.type}.`,
      );
  }
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) =>
    value instanceof FindOperator
      ? matchesOperator(row[key], value)
      : row[key] === value,
  );
}

/** `where` puede venir como arreglo, que en TypeORM significa OR entre sus condiciones. */
function matchesAny(
  row: Record<string, unknown>,
  where: Record<string, unknown> | Record<string, unknown>[],
) {
  return Array.isArray(where)
    ? where.some((condition) => matches(row, condition))
    : matches(row, where);
}

/**
 * Ordena como lo haría el `ORDER BY` que pide el llamador. Sólo lo que hace falta: una o varias
 * claves con dirección, comparando fechas y números por su valor.
 */
function sortRows<T>(rows: T[], order: Record<string, 'ASC' | 'DESC'>) {
  return [...rows].sort((a, b) => {
    for (const [key, direction] of Object.entries(order)) {
      const izquierda = (a as Record<string, unknown>)[key];
      const derecha = (b as Record<string, unknown>)[key];
      const izquierdaValor =
        izquierda instanceof Date ? izquierda.getTime() : izquierda;
      const derechaValor =
        derecha instanceof Date ? derecha.getTime() : derecha;

      if (izquierdaValor === derechaValor) {
        continue;
      }

      const menor = (izquierdaValor as number) < (derechaValor as number);
      return (menor ? -1 : 1) * (direction === 'DESC' ? -1 : 1);
    }

    return 0;
  });
}

export function createInMemoryRepository<T extends { id?: string }>(
  seed: T[] = [],
): InMemoryRepository<T> {
  const rows: T[] = [...seed];

  const repository: InMemoryRepository<T> = {
    rows,
    create: jest.fn((data: Partial<T>) => ({ ...data })),
    save: jest.fn(async (data: T) => {
      const existing = data.id
        ? rows.find((row) => row.id === data.id)
        : undefined;

      if (existing) {
        Object.assign(existing, data);
        return existing;
      }

      const created = { id: `generated-${++generatedIds}`, ...data } as T;
      rows.push(created);
      return created;
    }),
    find: jest.fn(async (options?: { where?: Record<string, unknown> }) =>
      options?.where
        ? rows.filter((row) => matchesAny(row as never, options.where))
        : [...rows],
    ),
    findOne: jest.fn(
      async (options: {
        where: Record<string, unknown>;
        order?: Record<string, 'ASC' | 'DESC'>;
      }) => {
        const candidatas = rows.filter((row) =>
          matchesAny(row as never, options.where),
        );
        const ordenadas = options.order
          ? sortRows(candidatas, options.order)
          : candidatas;

        return ordenadas[0] ?? null;
      },
    ),
    findOneBy: jest.fn(
      async (where: Record<string, unknown>) =>
        rows.find((row) => matches(row as never, where)) ?? null,
    ),
    /** Devuelve `null` sin filas que sumar, igual que Postgres con un `SUM` sin resultados. */
    sum: jest.fn(
      async (
        column: string,
        where?: Record<string, unknown> | Record<string, unknown>[],
      ) => {
        const candidatas = where
          ? rows.filter((row) => matchesAny(row as never, where))
          : rows;

        return candidatas.length
          ? candidatas.reduce(
              (total, row) => total + Number((row as never)[column] ?? 0),
              0,
            )
          : null;
      },
    ),
    update: jest.fn(
      async (
        criteria: string | Record<string, unknown>,
        changes: Partial<T>,
      ) => {
        const where =
          typeof criteria === 'string' ? { id: criteria } : criteria;
        const affected = rows.filter((row) => matches(row as never, where));
        affected.forEach((row) => Object.assign(row, changes));
        return { affected: affected.length };
      },
    ),
  };

  return repository;
}

/**
 * `DataSource` mínimo para `SubscriptionBillingService`, que abre una transacción y dentro de
 * ella pide repositorios por entidad, bloquea el perfil y lanza un `UPDATE` por query builder.
 *
 * La transacción se ejecuta en línea (sin rollback real). Lo que estas pruebas verifican del
 * lado transaccional es el EFECTO —que el lote se emita una sola vez y que el perfil quede
 * ACTIVE—, no el aislamiento, que es cosa de Postgres.
 */
export function createDataSourceStub(
  repositoriesByEntity: Map<unknown, InMemoryRepository<never>>,
) {
  const repositoryFor = (entity: unknown) => {
    const repository = repositoriesByEntity.get(entity);

    if (!repository) {
      throw new Error(
        `La prueba pidió un repositorio para una entidad que no registró: ${String(
          (entity as { name?: string })?.name ?? entity,
        )}`,
      );
    }

    return repository;
  };

  const rolloverExecute = jest.fn(async () => ({ affected: 0 }));

  const queryBuilder = {
    update: jest.fn(() => queryBuilder),
    set: jest.fn(() => queryBuilder),
    where: jest.fn(() => queryBuilder),
    andWhere: jest.fn(() => queryBuilder),
    execute: rolloverExecute,
  };

  const manager = {
    getRepository: jest.fn((entity: unknown) => repositoryFor(entity)),
    findOne: jest.fn(
      async (entity: unknown, options: { where: Record<string, unknown> }) =>
        repositoryFor(entity).findOne(options),
    ),
    update: jest.fn(
      async (entity: unknown, criteria: unknown, changes: unknown) =>
        repositoryFor(entity).update(criteria, changes),
    ),
    createQueryBuilder: jest.fn(() => queryBuilder),
  } as unknown as EntityManager;

  return {
    rolloverExecute,
    dataSource: {
      transaction: jest.fn(
        async (
          runInTransaction: (manager: EntityManager) => Promise<unknown>,
        ) => runInTransaction(manager),
      ),
    },
  };
}
