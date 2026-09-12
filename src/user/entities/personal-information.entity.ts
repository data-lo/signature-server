import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('personal_information')
export class PersonalInformationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'name' })
  name: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ name: 'curp' })
  curp: string;

  @Column({ nullable: true, name: 'rfc' })
  rfc: string | null;

  @Column({ nullable: true, name: 'phone_number' })
  phoneNumber: string | null;

  @Column({ nullable: true, name: 'secondary_email' })
  secondaryEmail: string | null;

  /**
   * Llave interna, en el bucket privado `identity-documents` de MinIO, de la imagen FRONTAL de la
   * INE que verificó Didit. Nunca la URL del proveedor ni la imagen: sólo dónde la guardamos.
   *
   * **`select: false`**: es un dato personal sensible y no debe salir por accidente en ninguna
   * respuesta, relación ni caché que cargue esta entidad (p. ej. `PUT /users/me/personal-information`
   * devuelve la fila completa). Sólo lo leen quienes lo piden explícitamente: el guardado de las
   * imágenes tras el webhook de Didit y el envío de la firma simple a Seal Service.
   *
   * `null` en la información personal anterior a esta historia o si la verificación no se completó.
   */
  @Column({ name: 'front_image_key', nullable: true, select: false })
  frontImageKey: string | null;

  /** Igual que `frontImageKey`, para la imagen TRASERA de la INE. */
  @Column({ name: 'back_image_key', nullable: true, select: false })
  backImageKey: string | null;
}
