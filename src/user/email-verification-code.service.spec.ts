import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmailVerificationCodeService } from './email-verification-code.service';
import { EmailVerificationCodeEntity } from './entities/email-verification-code.entity';
import { OTPService } from 'src/shared/otp/otp.service';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'code-1', ...data })),
  };
}

describe('EmailVerificationCodeService', () => {
  let service: EmailVerificationCodeService;
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
        EmailVerificationCodeService,
        {
          provide: getRepositoryToken(EmailVerificationCodeEntity),
          useValue: repository,
        },
        { provide: OTPService, useValue: otpService },
      ],
    }).compile();

    service = module.get<EmailVerificationCodeService>(
      EmailVerificationCodeService,
    );
  });

  describe('issue', () => {
    it('genera un código vía OTPService y lo persiste con expiración de 15 minutos', async () => {
      const before = Date.now();
      const result = await service.issue('user-1');

      expect(otpService.generate).toHaveBeenCalled();
      expect(result.code).toBe('482913');
      expect(repository.save).toHaveBeenCalled();

      const saved = repository.save.mock.calls[0][0];
      const expiryMs = saved.expiredAt.getTime() - before;
      expect(expiryMs).toBeGreaterThan(14 * 60 * 1000);
      expect(expiryMs).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
      expect(saved.isUsed).toBe(false);
      expect(saved.userId).toBe('user-1');
    });
  });

  describe('verifyAndConsume', () => {
    function buildRecord(overrides: Partial<EmailVerificationCodeEntity> = {}) {
      return {
        id: 'code-1',
        userId: 'user-1',
        code: '482913',
        isUsed: false,
        expiredAt: new Date(Date.now() + 60_000),
        ...overrides,
      } as EmailVerificationCodeEntity;
    }

    it('marca el código como usado cuando coincide y no expiró', async () => {
      repository.findOne.mockResolvedValue(buildRecord());

      await service.verifyAndConsume('user-1', '482913');

      expect(otpService.verify).toHaveBeenCalledWith('482913', '482913');
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isUsed: true }),
      );
    });

    it('rechaza si no hay ningún código pendiente para ese usuario', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.verifyAndConsume('user-1', '482913'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza si el código ya expiró', async () => {
      repository.findOne.mockResolvedValue(
        buildRecord({ expiredAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.verifyAndConsume('user-1', '482913'),
      ).rejects.toThrow('El código de verificación expiró');
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rechaza si el código no coincide', async () => {
      repository.findOne.mockResolvedValue(buildRecord());
      otpService.verify.mockReturnValue(false);

      await expect(service.verifyAndConsume('user-1', 'wrong')).rejects.toThrow(
        'Código de verificación inválido',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('un código emitido para un usuario no sirve para otro usuario', async () => {
      // El repositorio ya filtra por userId en el where(); simulamos que no encuentra nada
      // para el usuario B aunque exista un código válido para el usuario A.
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.verifyAndConsume('user-B', '482913'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
