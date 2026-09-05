export interface ResultadoVerificacion {
  esValida: boolean;
  hashCoincide: boolean;
  firmaValida: boolean;
  cadenaConfianzaValida: boolean;
  vigenteAlFirmar: boolean;
  detalle: {
    rfc: string;
    nombre: string;
    numeroCertificado: string;
    firmadoEn: Date;
  };
  errores: string[];
}
