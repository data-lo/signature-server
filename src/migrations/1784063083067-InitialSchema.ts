import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1784063083067 implements MigrationInterface {
  name = 'InitialSchema1784063083067';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."document_participants_role_enum" AS ENUM('signer', 'spectator')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."document_participants_status_enum" AS ENUM('pending', 'signed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TABLE "document_participants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "document_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" "public"."document_participants_role_enum" NOT NULL, "status" "public"."document_participants_status_enum" NOT NULL DEFAULT 'pending', "sign_order" integer NOT NULL DEFAULT '0', "signed_at" TIMESTAMP, "rejected_at" TIMESTAMP, "rejection_reason" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_98e9a565deb17c99eb40b5cd57d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."documents_status_enum" AS ENUM('pending', 'signed', 'rejected', 'expired', 'created', 'cancellation_pending', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "documents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "object_key" character varying NOT NULL, "file_name" character varying NOT NULL, "file_type" character varying NOT NULL, "total_pages" integer NOT NULL, "document_url" character varying, "ip_address" character varying NOT NULL, "verification_code_id" character varying, "original_hash" character varying NOT NULL, "signed_hash" character varying, "signed_at" TIMESTAMP, "cancelled_at" TIMESTAMP, "rejected_at" TIMESTAMP, "is_notified" boolean NOT NULL DEFAULT false, "status" "public"."documents_status_enum" NOT NULL DEFAULT 'created', "signature_coordinates" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" uuid NOT NULL, CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "signatures" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "signature_object_key" character varying, "official_card_object_key" character varying, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f56eb3cd344ce7f9ae28ce814eb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "organization_details" ("account_id" uuid NOT NULL, "name" character varying NOT NULL, CONSTRAINT "PK_c6539c8350dff84c1a1a46aee86" PRIMARY KEY ("account_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_type_enum" AS ENUM('PERSONAL', 'ORGANIZATION')`,
    );
    await queryRunner.query(
      `CREATE TABLE "accounts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "type" "public"."accounts_type_enum" NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_members_role_enum" AS ENUM('OWNER', 'ADMIN', 'SIGNEE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "account_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" "public"."account_members_role_enum" array NOT NULL, "position" character varying, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_64ad7a24bdd270694561759c6b7" UNIQUE ("account_id", "user_id"), CONSTRAINT "PK_9c6f17f4d2ab7caa5f03606020f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "personal_information" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "last_name" character varying NOT NULL, "curp" character varying NOT NULL, "rfc" character varying, "phone_number" character varying, "secondary_email" character varying, CONSTRAINT "PK_b870ed544fc4806dfeb05750237" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "first_name" character varying NOT NULL, "last_name" character varying NOT NULL, "email" character varying NOT NULL, "position" character varying NOT NULL, "roles" text NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "is_deleted" boolean NOT NULL DEFAULT false, "national_id" character varying(18) NOT NULL, "password" character varying NOT NULL, "signature_id" uuid, "personal_information_id" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_232b9597ff9a89b2c2fc5d1b5e5" UNIQUE ("national_id"), CONSTRAINT "REL_e991ab55a66eb0698987bae7b1" UNIQUE ("signature_id"), CONSTRAINT "REL_20b1c0b20f24c99e42b141c497" UNIQUE ("personal_information_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_subscriptions_plan_id_enum" AS ENUM('basic', 'pro', 'enterprise')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_subscriptions_status_enum" AS ENUM('incomplete', 'active', 'past_due', 'canceled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_subscriptions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "account_id" uuid NOT NULL, "plan_id" "public"."account_subscriptions_plan_id_enum", "stripe_customer_id" character varying, "stripe_subscription_id" character varying, "status" "public"."account_subscriptions_status_enum" NOT NULL DEFAULT 'incomplete', "current_period_end" TIMESTAMP, "signing_enabled" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_e824b033b6e49e61194ddb3f797" UNIQUE ("account_id"), CONSTRAINT "REL_e824b033b6e49e61194ddb3f79" UNIQUE ("account_id"), CONSTRAINT "PK_83a2cc0a3f89e9085f741552db1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants" ADD CONSTRAINT "FK_35bf22b44d913d26b80210d54fd" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants" ADD CONSTRAINT "FK_4bfded4a297643b190ca889a7e2" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_14371caaff44d0801b59b284166" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_details" ADD CONSTRAINT "FK_c6539c8350dff84c1a1a46aee86" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" ADD CONSTRAINT "FK_9beab0863ddc39238af9b8b95dd" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" ADD CONSTRAINT "FK_28435cf7197859fae41e0be3560" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_e991ab55a66eb0698987bae7b16" FOREIGN KEY ("signature_id") REFERENCES "signatures"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_20b1c0b20f24c99e42b141c4976" FOREIGN KEY ("personal_information_id") REFERENCES "personal_information"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" ADD CONSTRAINT "FK_e824b033b6e49e61194ddb3f797" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_subscriptions" DROP CONSTRAINT "FK_e824b033b6e49e61194ddb3f797"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_20b1c0b20f24c99e42b141c4976"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_e991ab55a66eb0698987bae7b16"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" DROP CONSTRAINT "FK_28435cf7197859fae41e0be3560"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_members" DROP CONSTRAINT "FK_9beab0863ddc39238af9b8b95dd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_details" DROP CONSTRAINT "FK_c6539c8350dff84c1a1a46aee86"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT "FK_14371caaff44d0801b59b284166"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants" DROP CONSTRAINT "FK_4bfded4a297643b190ca889a7e2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_participants" DROP CONSTRAINT "FK_35bf22b44d913d26b80210d54fd"`,
    );
    await queryRunner.query(`DROP TABLE "account_subscriptions"`);
    await queryRunner.query(
      `DROP TYPE "public"."account_subscriptions_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."account_subscriptions_plan_id_enum"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "personal_information"`);
    await queryRunner.query(`DROP TABLE "account_members"`);
    await queryRunner.query(`DROP TYPE "public"."account_members_role_enum"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TYPE "public"."accounts_type_enum"`);
    await queryRunner.query(`DROP TABLE "organization_details"`);
    await queryRunner.query(`DROP TABLE "signatures"`);
    await queryRunner.query(`DROP TABLE "documents"`);
    await queryRunner.query(`DROP TYPE "public"."documents_status_enum"`);
    await queryRunner.query(`DROP TABLE "document_participants"`);
    await queryRunner.query(
      `DROP TYPE "public"."document_participants_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."document_participants_role_enum"`,
    );
  }
}
