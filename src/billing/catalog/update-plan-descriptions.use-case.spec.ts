import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PlanEntity } from './plan.entity';
import { PlanNotFoundException } from './exceptions/plan.exceptions';
import { UpdatePlanDescriptionsUseCase } from './update-plan-descriptions.use-case';

describe('UpdatePlanDescriptionsUseCase', () => {
  const UPDATED_AT = new Date('2026-11-23T12:00:00.000Z');
  let useCase: UpdatePlanDescriptionsUseCase;
  let planRepository: { update: jest.Mock; findOneOrFail: jest.Mock };

  beforeEach(async () => {
    planRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneOrFail: jest.fn().mockImplementation(() =>
        Promise.resolve({
          planType: 'premium',
          descriptions: planRepository.update.mock.calls[0][1].descriptions,
          updatedAt: UPDATED_AT,
        }),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        UpdatePlanDescriptionsUseCase,
        { provide: getRepositoryToken(PlanEntity), useValue: planRepository },
      ],
    }).compile();

    useCase = module.get(UpdatePlanDescriptionsUseCase);
  });

  it('guarda la lista en el orden recibido y la devuelve', async () => {
    const descriptions = ['Hasta 10 documentos', 'Firma electrónica'];

    const result = await useCase.execute('premium', descriptions);

    expect(result).toEqual({
      planType: 'premium',
      descriptions,
      updatedAt: UPDATED_AT,
    });
  });

  it('actualiza ÚNICAMENTE descriptions del plan indicado', async () => {
    await useCase.execute('premium', ['Soporte por correo']);

    expect(planRepository.update).toHaveBeenCalledWith(
      { planType: 'premium' },
      { descriptions: ['Soporte por correo'] },
    );
  });

  it('permite dejar el plan sin descripciones', async () => {
    const result = await useCase.execute('premium', []);

    expect(planRepository.update).toHaveBeenCalledWith(
      { planType: 'premium' },
      { descriptions: [] },
    );
    expect(result.descriptions).toEqual([]);
  });

  it('responde 404 si el plan no existe, sin leer nada después', async () => {
    planRepository.update.mockResolvedValue({ affected: 0 });

    await expect(useCase.execute('inexistente', ['Firma'])).rejects.toThrow(
      new PlanNotFoundException('inexistente'),
    );
    expect(planRepository.findOneOrFail).not.toHaveBeenCalled();
  });
});
