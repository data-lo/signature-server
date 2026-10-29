import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Intentos de captura de la firma manuscrita (canvas en la PC o QR hacia el teléfono).
 *
 * La tabla no guarda la imagen ni gobierna el estado del usuario: el PNG vive en MinIO, la firma
 * vigente sigue siendo `users.signature_id` y el avance de la credencial sigue en
 * `users.signing_credential_status`. Lo que se persiste acá es el control y la auditoría de cada
 * intento —quién lo abrió, por qué canal, si el teléfono llegó a reclamarlo, cuándo vencía y qué
 * archivo produjo—, que es lo que permite responder después por qué una firma entró desde un
 * dispositivo distinto al de la sesión.
 */
export class CreateSignatureCaptureSessions1784300000030 implements MigrationInterface {
  name = 'CreateSignatureCaptureSessions1784300000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."signature_capture_sessions_channel_enum" AS ENUM('DESKTOP', 'MOBILE_QR')`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."signature_capture_sessions_status_enum" AS ENUM(
        'PENDING',
        'CLAIMED',
        'COMPLETED',
        'EXPIRED',
        'CANCELLED'
      )`,
    );

    await queryRunner.query(`
      CREATE TABLE "signature_capture_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "channel" "public"."signature_capture_sessions_channel_enum" NOT NULL,
        "status" "public"."signature_capture_sessions_status_enum" NOT NULL DEFAULT 'PENDING',
        "token_hash" character varying,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "signature_file_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_signature_capture_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_signature_capture_sessions_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_signature_capture_sessions_signature_file_id"
          FOREIGN KEY ("signature_file_id") REFERENCES "signatures"("id") ON DELETE SET NULL
      )
    `);

    /**
     * "Una sola sesión activa por usuario", garantizado por la base y no sólo por el caso de uso.
     *
     * Parcial porque el historial sí admite muchas filas terminales del mismo usuario. Sin este
     * índice, dos peticiones simultáneas —doble clic en "Generar QR", dos pestañas abiertas—
     * pasarían ambas la comprobación en memoria y dejarían dos códigos válidos a la vez.
     *
     * La lista de estados activos está duplicada acá y en `ACTIVE_SIGNATURE_CAPTURE_STATUSES`:
     * un índice parcial no puede leer un enum de TypeScript. Si alguna vez cambia, tiene que
     * cambiar en los dos sitios.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_signature_capture_sessions_active_user"
        ON "signature_capture_sessions" ("user_id")
        WHERE "status" IN ('PENDING', 'CLAIMED')
    `);

    /**
     * El token del QR se busca por su hash. Único —y parcial, porque las sesiones DESKTOP no
     * tienen token— para que dos sesiones no puedan responder nunca al mismo código.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_signature_capture_sessions_token_hash"
        ON "signature_capture_sessions" ("token_hash")
        WHERE "token_hash" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "signature_capture_sessions"');
    await queryRunner.query(
      `DROP TYPE "public"."signature_capture_sessions_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."signature_capture_sessions_channel_enum"`,
    );
  }
}
