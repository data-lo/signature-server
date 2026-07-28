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
}
