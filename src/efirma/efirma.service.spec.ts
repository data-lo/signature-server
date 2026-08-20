import { Test, TestingModule } from '@nestjs/testing';
import { EfirmaService } from './efirma.service';
import { OscpService } from './oscp/oscp.service';

describe('EfirmaService', () => {
  let service: EfirmaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EfirmaService,
        /**
         * `OscpService` se sustituye por un doble: el real consulta el endpoint OCSP del SAT
         * (`https://cfdi.sat.gob.mx/edofiel`) con un certificado de e.firma de verdad, así que
         * dejarlo entrar ataría esta prueba a la red y al SAT.
         *
         * Bug corregido: este módulo de prueba solo declaraba `EfirmaService`, pero desde que se
         * agregó la verificación OCSP el servicio recibe `OscpService` por constructor. Nest no
         * podía resolver la dependencia y la suite entera fallaba con "Nest can't resolve
         * dependencies of the EfirmaService".
         */
        { provide: OscpService, useValue: { verifyRevokedOCSP: jest.fn() } },
      ],
    }).compile();

    service = module.get<EfirmaService>(EfirmaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
