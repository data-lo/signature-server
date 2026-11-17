import { IntegrationSettingsEntity } from '../entities/integration-settings.entity';
import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';
import { IntegrationSettingsOrganizationNotFoundException } from '../exceptions/integration-settings.exceptions';
import { IntegrationSettingsService } from '../services/integration-settings.service';
import { GetIntegrationSettingsUseCase } from './get-integration-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './update-integration-settings.use-case';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-11T10:00:00.000Z');

function settings(status: INTEGRATION_STATUS_ENUM): IntegrationSettingsEntity {
  return {
    id: 'settings-1',
    organizationId: ORGANIZATION_ID,
    status,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  } as IntegrationSettingsEntity;
}

describe('casos de uso de configuración de integración', () => {
  let service: jest.Mocked<
    Pick<
      IntegrationSettingsService,
      'isActiveOrganization' | 'findByOrganization' | 'setStatus'
    >
  >;

  beforeEach(() => {
    service = {
      isActiveOrganization: jest.fn().mockResolvedValue(true),
      findByOrganization: jest.fn().mockResolvedValue(null),
      setStatus: jest.fn(),
    };
  });

  describe('GetIntegrationSettingsUseCase', () => {
    const useCase = () =>
      new GetIntegrationSettingsUseCase(
        service as unknown as IntegrationSettingsService,
      );

    it('devuelve la configuración guardada sin datos de API keys', async () => {
      service.findByOrganization.mockResolvedValue(
        settings(INTEGRATION_STATUS_ENUM.DISABLED),
      );

      const response = await useCase().execute(ORGANIZATION_ID);

      expect(response.success).toBe(true);
      expect(response.data).toEqual({
        organizationId: ORGANIZATION_ID,
        status: INTEGRATION_STATUS_ENUM.DISABLED,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
    });

    it('sin fila responde ACTIVE con fechas null y no escribe', async () => {
      const response = await useCase().execute(ORGANIZATION_ID);

      expect(response.data).toEqual({
        organizationId: ORGANIZATION_ID,
        status: INTEGRATION_STATUS_ENUM.ACTIVE,
        createdAt: null,
        updatedAt: null,
      });
      expect(service.setStatus).not.toHaveBeenCalled();
    });

    it('responde 404 ORGANIZATION_NOT_FOUND si la organización no existe o está inactiva', async () => {
      service.isActiveOrganization.mockResolvedValue(false);

      await expect(useCase().execute(ORGANIZATION_ID)).rejects.toBeInstanceOf(
        IntegrationSettingsOrganizationNotFoundException,
      );
      expect(service.findByOrganization).not.toHaveBeenCalled();
    });
  });

  describe('UpdateIntegrationSettingsUseCase', () => {
    const useCase = () =>
      new UpdateIntegrationSettingsUseCase(
        service as unknown as IntegrationSettingsService,
      );

    it('fija el estado pedido para la organización de la ruta', async () => {
      service.setStatus.mockResolvedValue(
        settings(INTEGRATION_STATUS_ENUM.DISABLED),
      );

      const response = await useCase().execute(ORGANIZATION_ID, {
        status: INTEGRATION_STATUS_ENUM.DISABLED,
      });

      expect(service.setStatus).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        INTEGRATION_STATUS_ENUM.DISABLED,
      );
      expect(response.data?.status).toBe(INTEGRATION_STATUS_ENUM.DISABLED);
    });

    it('responde 404 y no escribe si la organización no existe o está inactiva', async () => {
      service.isActiveOrganization.mockResolvedValue(false);

      await expect(
        useCase().execute(ORGANIZATION_ID, {
          status: INTEGRATION_STATUS_ENUM.ACTIVE,
        }),
      ).rejects.toBeInstanceOf(
        IntegrationSettingsOrganizationNotFoundException,
      );
      expect(service.setStatus).not.toHaveBeenCalled();
    });
  });
});
