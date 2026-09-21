import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Entidad propia (ver plan de migración ER-V2, Fase 5) — reemplaza a
 * OrganizationDetailEntity, que hasta ahora colgaba de accountId (una fila de "accounts" = un
 * tenant completo). Con Account pasando a ser una fila por (usuario × contexto), Organization
 * necesita su propio id: varios `Account` (uno por miembro) comparten un mismo `organizationId`
 * apuntando aquí.
 */
@Entity('organizations')
export class OrganizationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * La razón social: el nombre legal completo ("Acme Corp S.A. de C.V.").
   *
   * Es el que va en documentos y trámites, no el que se lee en pantalla — para eso está
   * `displayName`.
   */
  @Column()
  name: string;

  /**
   * El nombre corto con el que la organización se reconoce en la interfaz ("Acme").
   *
   * El formulario de alta lo pide desde siempre —`CreateOrganizationDto.name`, rotulado "Nombre
   * de visualización"— pero hasta ahora no se guardaba en ningún sitio: el alta escribía la razón
   * social en `name` y descartaba éste. El resultado era que el selector de cuentas rotulaba cada
   * organización con su nombre legal, que es justo lo que este campo existía para evitar.
   *
   * NOT NULL y sin valor por defecto: una organización sin nombre visible no tiene cómo
   * presentarse. Las que ya existían lo recibieron copiado de `name`
   * (`AddDisplayNameToOrganizations1784300000064`), que es lo que sus miembros venían leyendo.
   */
  @Column({ name: 'display_name' })
  displayName: string;

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ nullable: true, type: 'text' })
  address: string | null;

  @Column({ nullable: true })
  rfc: string | null;

  @Column({ nullable: true, name: 'domain_allowed' })
  domainAllowed: string | null;

  @Column({ nullable: true, name: 'phone_number' })
  phoneNumber: string | null;

  @Column({ default: false, name: 'index_documents' })
  indexDocuments: boolean;
}
