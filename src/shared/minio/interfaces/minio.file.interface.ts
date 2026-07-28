export interface MinioFileI {
  file: Express.Multer.File | Buffer;
  name: string;
  mimetype?: string;
}
