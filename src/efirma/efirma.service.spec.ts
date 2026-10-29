import { Test, TestingModule } from '@nestjs/testing';
import { EfirmaService } from './efirma.service';
import { OscpService } from './oscp/oscp.service';

/**
 * `OscpService` se sustituye por un doble en vez de proveerse de verdad: su única operación
 * (`verifyRevokedOCSP`) sale a la red contra el respondedor del SAT
 * (https://cfdi.sat.gob.mx/edofiel), y una prueba unitaria no puede depender de un servicio
 * externo. Sin él en el módulo, Nest no puede construir `EfirmaService` —lleva `OscpService` en
 * su constructor desde que la firma avanzada verifica revocación— y la suite fallaba entera al
 * resolver dependencias.
 */
describe('EfirmaService', () => {
  let service: EfirmaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EfirmaService,
        { provide: OscpService, useValue: { verifyRevokedOCSP: jest.fn() } },
      ],
    }).compile();

    service = module.get<EfirmaService>(EfirmaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
