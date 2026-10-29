import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountMemberService } from 'src/account/account-member.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DocumentReviewerService } from './document-reviewer.service';

/**
 * Historia "Implementar flujo de aprobación previo al proceso de firma": quién puede ser elegido
 * aprobador de un documento.
 */
describe('DocumentReviewerService', () => {
  let service: DocumentReviewerService;
  let accountMemberService: Record<string, jest.Mock>;

  beforeEach(async () => {
    accountMemberService = {
      findActiveMembershipWithPermission: jest.fn(),
      findPersonalAccountId: jest.fn().mockResolvedValue('account-personal-1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentReviewerService,
        { provide: AccountMemberService, useValue: accountMemberService },
      ],
    }).compile();

    service = module.get(DocumentReviewerService);
  });

  it('pregunta por la membresía activa del aprobador con el permiso DOCUMENT.APPROVE', async () => {
    accountMemberService.findActiveMembershipWithPermission.mockResolvedValue({
      id: 'account-org-1',
    });

    await service.resolveReviewerAccountId('user-aprobador', 'org-1');

    expect(
      accountMemberService.findActiveMembershipWithPermission,
    ).toHaveBeenCalledWith(
      'user-aprobador',
      'org-1',
      RESOURCE_KEY_ENUM.DOCUMENT,
      ACTION_KEY_ENUM.APPROVE,
    );
  });

  /**
   * El colaborador se ancla a la cuenta PERSONAL y no a la membresía de organización: lo que
   * aprueba es la persona, y la membresía puede revocarse dejando el documento colgando.
   */
  it('devuelve la cuenta PERSONAL del aprobador, no su membresía en la organización', async () => {
    accountMemberService.findActiveMembershipWithPermission.mockResolvedValue({
      id: 'account-org-1',
    });

    const accountId = await service.resolveReviewerAccountId(
      'user-aprobador',
      'org-1',
    );

    expect(accountId).toBe('account-personal-1');
    expect(accountMemberService.findPersonalAccountId).toHaveBeenCalledWith(
      'user-aprobador',
    );
  });

  /**
   * Los tres motivos por los que no hay membresía —no existe el usuario, no es miembro, su rol no
   * concede el permiso— dan el MISMO error: distinguirlos le diría a cualquiera que pueda crear
   * un documento si un identificador existe en la plataforma y a qué organización pertenece.
   */
  it('rechaza al aprobador que no es miembro activo con permiso para aprobar', async () => {
    accountMemberService.findActiveMembershipWithPermission.mockResolvedValue(
      null,
    );

    await expect(
      service.resolveReviewerAccountId('user-aprobador', 'org-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accountMemberService.findPersonalAccountId).not.toHaveBeenCalled();
  });

  it('rechaza asignar aprobador fuera de una organización', async () => {
    await expect(
      service.resolveReviewerAccountId('user-aprobador', null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      accountMemberService.findActiveMembershipWithPermission,
    ).not.toHaveBeenCalled();
  });
});
