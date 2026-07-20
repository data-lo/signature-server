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

  @Column()
  name: string;

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
