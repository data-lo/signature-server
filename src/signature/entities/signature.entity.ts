import { DocumentEntity } from "src/document/entities/document.entity";
import { UserEntity } from "src/user/entities/user.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('signatures')
export class SignatureEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'signature_object_key' })
  signatureObjectKey: string;

  @Column({ nullable: true, name: 'official_card_object_key' })
  officialCardObjectKey: string | null;

  @Column({ nullable: true, name: 'created_by' })
  createdBy: string | null;

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ nullable: false, name: 'user_id', unique: true })
  userId: string;

  @OneToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
