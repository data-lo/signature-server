/** Operación de MinIO a la que se le puede inyectar un fallo. */
export type MinioOperation = 'get' | 'putPdf' | 'putSensitive';

interface MinioFile {
  file: Buffer;
  name: string;
  mimetype: string;
}

/**
 * MinIO en memoria con los métodos de `MinioService` que usa el sellado. Guarda copias de los
 * bytes, así que una prueba puede comparar el antes y el después de un objeto.
 *
 * `failNext(op)` hace fallar la siguiente llamada de esa operación, como una caída transitoria.
 */
export class InMemoryMinio {
  readonly objects = new Map<string, Buffer>();
  readonly uploads: { bucket: string; key: string }[] = [];
  private readonly pendingFailures: MinioOperation[] = [];

  /**
   * Programa un fallo.
   *
   * @param operation - Operación que fallará una vez.
   * @returns El propio stub.
   */
  failNext(operation: MinioOperation): this {
    this.pendingFailures.push(operation);
    return this;
  }

  /**
   * Lee un objeto guardado.
   *
   * @param bucket - Bucket.
   * @param key - Llave.
   * @returns Los bytes, o `undefined`.
   */
  read(bucket: string, key: string): Buffer | undefined {
    return this.objects.get(`${bucket}/${key}`);
  }

  /** Escribe un objeto directamente (para sembrar fixtures). */
  write(bucket: string, key: string, content: Buffer): void {
    this.objects.set(`${bucket}/${key}`, Buffer.from(content));
  }

  async putSensitiveObject(
    bucket: string,
    key: string,
    content: Buffer,
  ): Promise<void> {
    this.maybeFail('putSensitive');
    this.write(bucket, key, content);
  }

  async getSensitiveObject(bucket: string, key: string): Promise<Buffer> {
    return this.get(bucket, key);
  }

  async removeSensitiveObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async getFileInBytesFormat(key: string, bucket: string): Promise<Buffer> {
    return this.get(bucket, key);
  }

  async uploadPdfAObject(
    file: MinioFile,
    bucket: string,
    _signerNames: string,
    key: string,
  ): Promise<{ fileId: string }> {
    this.maybeFail('putPdf');
    this.write(bucket, key, file.file);
    this.uploads.push({ bucket, key });
    return { fileId: key };
  }

  async getFile(
    key: string,
    bucket: string,
  ): Promise<{ secureUrl: string; expiresIn: number }> {
    return {
      secureUrl: `https://minio.test.invalid/${bucket}/${key}`,
      expiresIn: 300,
    };
  }

  private get(bucket: string, key: string): Buffer {
    this.maybeFail('get');
    const content = this.objects.get(`${bucket}/${key}`);
    if (!content) {
      throw new Error(`El archivo ${key} no existe en el bucket ${bucket}`);
    }
    return Buffer.from(content);
  }

  private maybeFail(operation: MinioOperation): void {
    const index = this.pendingFailures.indexOf(operation);
    if (index >= 0) {
      this.pendingFailures.splice(index, 1);
      throw new Error(`MinIO no disponible (${operation})`);
    }
  }
}
