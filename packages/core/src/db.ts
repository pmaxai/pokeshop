import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
/** Either a pool or a transaction: repository functions accept both. */
export type Db = Sql | Tx;

/** Custom SQLSTATE codes raised by the stock functions (see migrations). */
export const SQLSTATE = {
  insufficientStock: 'SH001',
  invalidArgument: 'SH002',
  alreadyReserved: 'SH003',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

export function createSql(
  url = process.env.DATABASE_URL,
  options: { max?: number; applicationName?: string } = {},
): Sql {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sslMode = process.env.DATABASE_SSL ?? 'disable';
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: sslMode === 'require' ? 'require' : sslMode === 'verify-full' ? 'verify-full' : false,
    connection: { application_name: options.applicationName ?? 'pokeshop' },
    onnotice: () => {},
    transform: { undefined: null },
    types: {
      // bigint ids and counts fit comfortably into a JS number here
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number | bigint | string) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  }) as unknown as Sql;
}

const globalForSql = globalThis as unknown as { __pokeshopSql?: Sql };

/** Shared pool for the running process (survives hot reloads in development). */
export function getSql(): Sql {
  globalForSql.__pokeshopSql ??= createSql();
  return globalForSql.__pokeshopSql;
}

export function isPgError(e: unknown, code?: string): e is postgres.PostgresError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { name?: string }).name === 'PostgresError' &&
    (code === undefined || (e as { code: string }).code === code)
  );
}
