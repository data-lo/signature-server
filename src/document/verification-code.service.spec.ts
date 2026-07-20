import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import { OTPService } from 'src/shared/otp/otp.service';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'code-1', ...data })),
  };
}

describe('VerificationCodeService', () => {
  let service: VerificationCodeService;
  let repository: ReturnType<typeof createMockRepository>;
  let otpService: { generate: jest.Mock; verify: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    otpService = {
      generate: jest.fn().mockReturnValue('482913'),
      verify: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationCodeService,
        {
          provide: getRepositoryToken(VerificationCodeEntity),
          useValue: repository,
        },
        { provide: OTPService, useValue: otpService },
      ],
    }).compile();

    service = module.get<VerificationCodeService>(VerificationCodeService);
  });

  describe('issue', () => {
    it('genera un código vía OTPService y lo persiste con expiración de 15 minutos', async () => {
      const before = Date.now();
      const result = await service.issue(
        'doc-1',
        'collaborator-1',
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
        '127.0.0.1',
      );

      expect(otpService.generate).toHaveBeenCalled();
      expect(result.code).toBe('482913');
      expect(repository.save).toHaveBeenCalled();

      const saved = repository.save.mock.calls[0][0];
      const expiryMs = saved.expiredAt.getTime() - before;
      expect(expiryMs).toBeGreaterThan(14 * 60 * 1000);
      expect(expiryMs).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
      expect(saved.isUsed).toBe(false);
    });
  });

  describe('verifyAndConsume', () => {
    function buildRecord(overrides: Partial<VerificationCodeEntity> = {}) {
      return {
        id: 'code-1',
        documentId: 'doc-1',
        signerId: 'collaborator-1',
        code: '482913',
        isUsed: false,
        expiredAt: new Date(Date.now() + 60_000),
        ...overrides,
      } as VerificationCodeEntity;
    }

    it('marca el código como usado cuando coincide y no expiró', async () => {
      const record = buildRecord();
      repository.findOne.mockResolvedValue(record);

      await service.verifyAndConsume('doc-1', 'collaborator-1', '482913');

      expect(otpService.verify).toHaveBeenCalledWith('482913', '482913');
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isUsed: true }),
      );
    });

    it('rechaza si no hay ningún código pendiente para ese documento/firmante', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.verifyAndConsume('doc-1', 'collaborator-1', '482913'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el código ya expiró', async () => {
      repository.findOne.mockResolvedValue(
        buildRecord({ expiredAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.verifyAndConsume('doc-1', 'collaborator-1', '482913'),
      ).rejects.toThrow('El código de verificación expiró');
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rechaza si el código no coincide', async () => {
      repository.findOne.mockResolvedValue(buildRecord());
      otpService.verify.mockReturnValue(false);

      await expect(
        service.verifyAndConsume('doc-1', 'collaborator-1', 'wrong'),
      ).rejects.toThrow('Código de verificación inválido');
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('un código emitido para un documento no sirve para otro documento', async () => {
      // El repositorio ya filtra por documentId en el where(); simulamos que no encuentra nada
      // para el documento B aunque exista un código válido para el documento A.
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.verifyAndConsume('doc-B', 'collaborator-1', '482913'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('hasConsumedCode', () => {
    it('retorna true si existe un código consumido para ese documento/firmante/evento', async () => {
      repository.findOne.mockResolvedValue({ id: 'code-1', isUsed: true });

      const result = await service.hasConsumedCode(
        'doc-1',
        'collaborator-1',
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );

      expect(result).toBe(true);
    });

    it('retorna false si no hay ningún código consumido', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.hasConsumedCode(
        'doc-1',
        'collaborator-1',
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );

      expect(result).toBe(false);
    });
  });
});
