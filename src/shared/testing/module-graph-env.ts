/**
 * Define las variables de entorno mínimas para instanciar el grafo de Nest en una prueba.
 *
 * Varios servicios de infraestructura (`HashService`, `MinioService`) validan su configuración en el
 * constructor y lanzan si falta: es lo correcto en producción, pero significa que cualquier prueba
 * que compile un módulo de verdad necesita estos valores presentes.
 *
 * Sin esto, cada prueba de grafo dependía en silencio de que `hash.service.spec.ts` o
 * `minio.service.spec.ts` se hubieran ejecutado antes en el mismo worker de Jest: agregar o quitar
 * suites cambiaba el reparto entre workers y rompía pruebas que nadie había tocado.
 *
 * Usa `??=` para no pisar lo que el entorno ya traiga: si alguien corre las pruebas contra una
 * configuración real, esa gana.
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
