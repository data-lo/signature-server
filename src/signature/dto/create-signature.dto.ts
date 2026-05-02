import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateSignatureDto {
  /**
   * UUID del usuario al que se asignará esta firma.
   * Después de crear la firma, se actualiza el signatureId del usuario automáticamente.
   */
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  /**
   * UUID del usuario que está registrando la firma (administrador o responsable).
   * Opcional: si no se envía, queda en null.
   */
  @IsUUID()
  @IsOptional()
  createdBy?: string;
}
