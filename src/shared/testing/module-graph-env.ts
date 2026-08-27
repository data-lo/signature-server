/**
 * Variables de entorno mínimas para poder instanciar el grafo de Nest en una prueba.
 *
 * Varios servicios de infraestructura (`HashService`, `MinioService`) validan su configuración
 * en el constructor y lanzan si falta: es lo correcto en producción —mejor no arrancar que
 * arrancar sin poder cifrar ni guardar archivos—, pero significa que cualquier prueba que
 * compile un módulo de verdad necesita estos valores presentes.
 *
 * Antes cada prueba de grafo dependía, sin decirlo, de que `hash.service.spec.ts` o
 * `minio.service.spec.ts` se hubieran ejecutado antes en el mismo worker de Jest y hubieran
 * dejado las variables puestas en `process.env`. Eso hacía que agregar o quitar suites
 * cambiara el reparto entre workers y rompiera pruebas que no se habían tocado.
 *
 * Se usa `??=` para no pisar lo que el entorno ya traiga: si alguien corre las pruebas contra
 * una configuración real, esa gana.
 */
export function setTestModuleGraphEnv(): void {
  process.env.CIPHER_SECRET ??= 'test-cipher-secret';

  process.env.MINIO_HOST ??= 'localhost';
  process.env.MINIO_PORT ??= '9010';
  process.env.MINIO_PUBLIC_HOST ??= 'localhost';
  process.env.MINIO_PUBLIC_PORT ??= '9010';
  process.env.MINIO_REGION ??= 'mx-central-1';
  process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
  process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

  process.env.MINIO_CREATED_DOCUMENTS_BUCKET ??= 'created-documents';
  process.env.MINIO_PARTIALLY_SIGNED_DOCUMENTS_BUCKET ??=
    'partially-signed-documents';
  process.env.MINIO_SIGNED_DOCUMENTS_BUCKET ??= 'signed-documents';
  process.env.MINIO_FINALIZED_DOCUMENTS_BUCKET ??= 'finalized-documents';
  process.env.MINIO_REJECTED_DOCUMENTS_BUCKET ??= 'rejected-documents';
  process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET ??= 'cancelled-documents';
  process.env.MINIO_SIGNATURE_IMAGES_BUCKET ??= 'signature-images';
  process.env.MINIO_OFICIAL_CARDS_BUCKET ??= 'oficial-id-cards';

  process.env.SENDGRID_API_KEY ??= 'SG.test-api-key';
  process.env.SENDGRID_FROM_EMAIL ??= 'no-reply@ejemplo.com';
  process.env.FRONTEND_URL ??= 'https://app.ejemplo.com';

  process.env.STRIPE_SECRET_KEY ??= 'sk_test_123';
}
