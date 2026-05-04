/**
 * DTO para la actualización de firma e INE.
 * Los archivos (imagen_firma, imagen_ine) se reciben como multipart/form-data
 * a través de los decoradores @UploadedFiles() en el controlador,
 * por lo que este DTO no necesita campos de cuerpo adicionales.
 */
export class UpdateSignatureDto {}
