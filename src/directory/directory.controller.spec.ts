import { Test } from '@nestjs/testing';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { ArchiveDirectoryContactUseCase } from './applications/archive-directory-contact.use-case';
import { CreateDirectoryContactUseCase } from './applications/create-directory-contact.use-case';
import { ListDirectoryContactsUseCase } from './applications/list-directory-contacts.use-case';
import { UpdateDirectoryContactUseCase } from './applications/update-directory-contact.use-case';
import { DirectoryController } from './directory.controller';
import { CreateDirectoryContactDto } from './dto/create-directory-contact.dto';
import { ListDirectoryContactsDto } from './dto/list-directory-contacts.dto';

const AUTHORIZATION: AuthorizationContext = {
  userId: 'user-1',
  organizationId: null,
  accountId: 'account-personal',
  roleId: null,
  resource: RESOURCE_KEY_ENUM.DIRECTORY,
  action: ACTION_KEY_ENUM.READ,
  scopes: [PERMISSION_SCOPE_ENUM.ANY],
};

const ACTOR = { authorization: AUTHORIZATION, activeAccountId: 'account-1' };

/** El controller sólo traduce: cada endpoint arma la solicitud tipada de su caso de uso. */
describe('DirectoryController', () => {
  let controller: DirectoryController;
  const listUseCase = { execute: jest.fn() };
  const createUseCase = { execute: jest.fn() };
  const updateUseCase = { execute: jest.fn() };
  const archiveUseCase = { execute: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [DirectoryController],
      providers: [
        { provide: ListDirectoryContactsUseCase, useValue: listUseCase },
        { provide: CreateDirectoryContactUseCase, useValue: createUseCase },
        { provide: UpdateDirectoryContactUseCase, useValue: updateUseCase },
        { provide: ArchiveDirectoryContactUseCase, useValue: archiveUseCase },
      ],
    }).compile();

    controller = moduleRef.get(DirectoryController);
  });

  it('el listado aplica la paginación por omisión y descarta la búsqueda vacía', async () => {
    await controller.listContacts(AUTHORIZATION, 'account-1', {
      search: '',
    } as ListDirectoryContactsDto);

    expect(listUseCase.execute).toHaveBeenCalledWith({
      actor: ACTOR,
      search: undefined,
      page: 1,
      limit: 25,
    });
  });

  /** El `ValidationPipe` global ya los descarta; esto comprueba que el mapeo tampoco los pasa. */
  it('el alta pasa sólo los campos del contacto, sin directoryId ni autoría', async () => {
    await controller.createContact(AUTHORIZATION, 'account-1', {
      firstName: 'Ana',
      lastName: 'García',
      email: 'ana@example.com',
      directoryId: 'directory-ajeno',
      createdByAccountId: 'account-ajena',
    } as CreateDirectoryContactDto);

    expect(createUseCase.execute).toHaveBeenCalledWith({
      actor: ACTOR,
      contact: {
        firstName: 'Ana',
        lastName: 'García',
        email: 'ana@example.com',
        taxId: undefined,
        phone: undefined,
      },
    });
  });

  it('la edición conserva null para vaciar RFC y teléfono', async () => {
    await controller.updateContact(
      AUTHORIZATION,
      'account-1',
      { contactId: 'contact-1' },
      { taxId: null, phone: null },
    );

    expect(updateUseCase.execute).toHaveBeenCalledWith({
      actor: ACTOR,
      contactId: 'contact-1',
      changes: {
        firstName: undefined,
        lastName: undefined,
        email: undefined,
        taxId: null,
        phone: null,
      },
    });
  });

  it('el archivado pasa el contactId de la ruta', async () => {
    await controller.archiveContact(AUTHORIZATION, 'account-1', {
      contactId: 'contact-1',
    });

    expect(archiveUseCase.execute).toHaveBeenCalledWith({
      actor: ACTOR,
      contactId: 'contact-1',
    });
  });
});
