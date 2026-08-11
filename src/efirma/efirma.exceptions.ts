import { UnprocessableEntityException }  from "@nestjs/common";

export class CertificadoInvalidoException extends UnprocessableEntityException {
    constructor(detalle?:string){
        super(`El certificado no encadena a una AC del SAT valida${detalle ? `${detalle}`: '' }`)
    }
}

export class CertificadoExpiradoException extends UnprocessableEntityException {
    constructor(vigenciaHasta:Date){
        super(`El certificado (.cer) expiró su vigencia el ${vigenciaHasta.toISOString()}`);
    }
}

export class LLavePrivadaInvalidException extends UnprocessableEntityException {
    constructor(dettalle?: string){
        super(
            `No fue posible descifrar la llave privada (.key). verifica la constraseña.${
                dettalle ? `Detalle: ${dettalle}` : ''
            }`
        );
    };
}

export class LLaveNoCorrespondeCertificadoException extends UnprocessableEntityException {
    constructor(){
        super('La llave privada (.key) no corresponde al certificado proporcionado');
    }
}

export class CadenaConfianzaInvalidaException extends UnprocessableEntityException {
    constructor(detalle?:string){
        super(`El certificado no encadena a una AC del SAT valida${detalle ? `${detalle}`: '' }`)
    }
}

export class CertificadoRevocadoException extends Error {
    constructor(
        public readonly revokedDate?:Date, 
        public readonly reason?:string
    ){
       super(
      `El certificado fue revocado por el SAT${revokedDate ? ` el ${revokedDate.toISOString()}` : ''}${reason ? 
        ` (razón: ${reason})` : ''}`,
    );
    this.name = 'CertificadoRevocadoException';
  }
}

export class OCSPNotAvilableException extends Error {
  constructor(reason: string) {
    super(`No fue posible verificar el estado de revocación ante el SAT: ${reason}`);
    this.name = 'OCSNotAvilableException';
  }
}