import { Test, TestingModule } from '@nestjs/testing';
import { MinioService } from './minio.service';

describe('MinioService', () => {
  let service: MinioService;

  beforeEach(async () => {
    process.env.MINIO_HOST = 'localhost';
    process.env.MINIO_PORT = '9010';
    process.env.MINIO_ACCESS_KEY = 'test-access-key';
    process.env.MINIO_SECRET_KEY = 'test-secret-key';
    process.env.MINIO_CREATED_DOCUMENTS_BUCKET = 'created-documents';
    process.env.MINIO_SIGNED_DOCUMENTS_BUCKET = 'signed-documents';
    process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET = 'cancelled-documents';
    process.env.MINIO_REJECTED_DOCUMENTS_BUCKET = 'rejected-documents';
    process.env.MINIO_OFICIAL_CARDS_BUCKET = 'oficial-id-cards';
    process.env.MINIO_SIGNATURE_IMAGES_BUCKET = 'signature-images';

    const module: TestingModule = await Test.createTestingModule({
      providers: [MinioService],
    }).compile();

    service = module.get<MinioService>(MinioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
