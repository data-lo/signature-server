import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import {
  ProvisionalOwnerEmailAlreadyRegisteredException,
  ProvisionalOwnerUnavailableException,
} from '../exceptions/platform-provisioning.exceptions';
import { ProvisionalOwnerProvisioningService } from './provisional-owner-provisioning.service';

describe('ProvisionalOwnerProvisioningService', () => {
  const manager = { marker: 'tx' } as never;
  const identity = {
    email: 'ana@acme.test',
    firstName: 'Ana',
    lastName: 'López',
  };

  let userService: {
    findByEmailForUpdate: jest.Mock;
    createProvisionedUser: jest.Mock;
  };
  let accountService: { findPersonalAccount: jest.Mock };
  let service: ProvisionalOwnerProvisioningService;

  function existingUser(overrides: Record<string, unknown> = {}) {
    return {
      id: 'user-1',
      email: identity.email,
      lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      isActive: true,
      isDeleted: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    userService = {
      findByEmailForUpdate: jest.fn().mockResolvedValue(null),
      createProvisionedUser: jest.fn().mockResolvedValue({
        user: existingUser({ id: 'user-new' }),
        personalAccount: { id: 'personal-new' },
      }),
    };
    accountService = {
      findPersonalAccount: jest.fn().mockResolvedValue({ id: 'personal-1' }),
    };
    service = new ProvisionalOwnerProvisioningService(
      userService as never,
      accountService as never,
    );
  });

  it('crea un usuario PROVISIONED con su cuenta personal si el correo no existe', async () => {
    const owner = await service.resolve(manager, identity);

    expect(userService.findByEmailForUpdate).toHaveBeenCalledWith(
      manager,
      identity.email,
    );
    expect(userService.createProvisionedUser).toHaveBeenCalledWith(
      manager,
      identity,
    );
    expect(owner).toEqual({
      user: expect.objectContaining({ id: 'user-new' }),
      personalAccount: { id: 'personal-new' },
      created: true,
    });
  });

  it('reutiliza un usuario PROVISIONED activo sin reescribir sus datos', async () => {
    userService.findByEmailForUpdate.mockResolvedValue(existingUser());

    const owner = await service.resolve(manager, {
      ...identity,
      firstName: 'Otro nombre',
    });

    expect(userService.createProvisionedUser).not.toHaveBeenCalled();
    expect(accountService.findPersonalAccount).toHaveBeenCalledWith(
      manager,
      'user-1',
    );
    expect(owner).toEqual({
      user: expect.objectContaining({ id: 'user-1' }),
      personalAccount: { id: 'personal-1' },
      created: false,
    });
  });

  /** Una cuenta de pruebas no se cuelga de la cuenta real (con contraseña) de una persona. */
  it('rechaza con 409 el correo de un usuario ACTIVE', async () => {
    userService.findByEmailForUpdate.mockResolvedValue(
      existingUser({ lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.ACTIVE }),
    );

    await expect(service.resolve(manager, identity)).rejects.toBeInstanceOf(
      ProvisionalOwnerEmailAlreadyRegisteredException,
    );
    expect(userService.createProvisionedUser).not.toHaveBeenCalled();
  });

  it.each([
    ['desactivado', { isActive: false }],
    ['borrado', { isDeleted: true }],
  ])('rechaza con 409 un provisional %s', async (_label, overrides) => {
    userService.findByEmailForUpdate.mockResolvedValue(existingUser(overrides));

    await expect(service.resolve(manager, identity)).rejects.toBeInstanceOf(
      ProvisionalOwnerUnavailableException,
    );
  });

  it('rechaza con 409 un provisional sin cuenta personal', async () => {
    userService.findByEmailForUpdate.mockResolvedValue(existingUser());
    accountService.findPersonalAccount.mockResolvedValue(null);

    await expect(service.resolve(manager, identity)).rejects.toBeInstanceOf(
      ProvisionalOwnerUnavailableException,
    );
  });
});
