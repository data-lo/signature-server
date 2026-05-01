export class CreateUserDto {
  name: string;
  lastname: string;
  email: string;
  position?: string;
  signatureId: string;
  documentId: string;
  isActive: boolean;
  rol: string[];
  curp: string;
}
