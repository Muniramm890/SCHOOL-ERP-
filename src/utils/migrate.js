// src/utils/migrate.js
// Run: node src/utils/migrate.js
// Creates all tables if they don't exist — safe to run multiple times
require('dotenv').config();
const { getPool, sql } = require('../config/db');
const logger = require('./logger');

const migrations = [

// ── user_auth (not in schema log but needed for login) ─────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='user_auth')
 CREATE TABLE user_auth (
   id              UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   user_id         UNIQUEIDENTIFIER NOT NULL UNIQUE,
   password_hash   NVARCHAR(255)    NOT NULL,
   failed_attempts INT              NOT NULL DEFAULT(0),
   locked_until    DATETIME2            NULL,
   created_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE())
 )`,

// ── organisations ────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='organisations')
 CREATE TABLE organisations (
   id                  UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   name                NVARCHAR(255)    NOT NULL,
   slug                NVARCHAR(255)    NOT NULL UNIQUE,
   owner_email         NVARCHAR(255)    NOT NULL,
   gstin               NVARCHAR(50)         NULL,
   pan                 NVARCHAR(50)         NULL,
   registered_address  NVARCHAR(MAX)        NULL,
   contact_phone       NVARCHAR(50)         NULL,
   logo_url            NVARCHAR(MAX)        NULL,
   plan_type           NVARCHAR(50)     NOT NULL DEFAULT('basic'),
   plan_expires_at     DATETIME2            NULL,
   max_schools         INT              NOT NULL DEFAULT(1),
   is_active           BIT              NOT NULL DEFAULT(1),
   metadata            NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at          DATETIME2            NULL
 )`,

// ── users ────────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='users')
 CREATE TABLE users (
   id                  UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   full_name           NVARCHAR(255)    NOT NULL,
   display_name        NVARCHAR(255)        NULL,
   email               NVARCHAR(255)    NOT NULL UNIQUE,
   phone               NVARCHAR(50)         NULL,
   avatar_url          NVARCHAR(MAX)        NULL,
   date_of_birth       DATE                 NULL,
   gender              VARCHAR(20)          NULL,
   address             NVARCHAR(MAX)        NULL,
   emergency_contact   NVARCHAR(50)         NULL,
   is_active           BIT              NOT NULL DEFAULT(1),
   last_login_at       DATETIME2            NULL,
   metadata            NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at          DATETIME2            NULL
 )`,

// ── schools ──────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='schools')
 CREATE TABLE schools (
   id                    UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   organisation_id       UNIQUEIDENTIFIER NOT NULL,
   name                  NVARCHAR(255)    NOT NULL,
   slug                  NVARCHAR(255)    NOT NULL UNIQUE,
   tagline               NVARCHAR(500)        NULL,
   logo_url              NVARCHAR(MAX)        NULL,
   brand_color           VARCHAR(10)          NULL DEFAULT('#E8600A'),
   affiliation_board     NVARCHAR(100)        NULL,
   affiliation_no        NVARCHAR(100)        NULL,
   udise_code            NVARCHAR(100)        NULL,
   address_line1         NVARCHAR(500)    NOT NULL,
   address_line2         NVARCHAR(500)        NULL,
   city                  NVARCHAR(100)    NOT NULL,
   state                 NVARCHAR(100)    NOT NULL,
   pincode               CHAR(6)              NULL,
   country               NVARCHAR(100)    NOT NULL DEFAULT('India'),
   phone                 NVARCHAR(50)         NULL,
   email                 NVARCHAR(255)        NULL,
   website               NVARCHAR(255)        NULL,
   principal_name        NVARCHAR(255)        NULL,
   established_year      SMALLINT             NULL,
   timezone              NVARCHAR(100)    NOT NULL DEFAULT('Asia/Kolkata'),
   academic_year_start   SMALLINT         NOT NULL DEFAULT(4),
   academic_year_end     SMALLINT         NOT NULL DEFAULT(3),
   working_days          NVARCHAR(MAX)        NULL DEFAULT('["monday","tuesday","wednesday","thursday","friday","saturday"]'),
   periods_per_day       SMALLINT         NOT NULL DEFAULT(8),
   period_duration_min   SMALLINT         NOT NULL DEFAULT(45),
   school_start_time     TIME             NOT NULL DEFAULT('08:00'),
   school_end_time       TIME             NOT NULL DEFAULT('14:30'),
   is_active             BIT              NOT NULL DEFAULT(1),
   settings              NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at            DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at            DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at            DATETIME2            NULL
 )`,

// ── school_members ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='school_members')
 CREATE TABLE school_members (
   id             UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id      UNIQUEIDENTIFIER NOT NULL,
   user_id        UNIQUEIDENTIFIER NOT NULL,
   role           VARCHAR(50)      NOT NULL,
   employee_code  NVARCHAR(100)        NULL,
   join_date      DATE                 NULL,
   relieving_date DATE                 NULL,
   is_active      BIT              NOT NULL DEFAULT(1),
   permissions    NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at     DATETIME2            NULL,
   UNIQUE(school_id, user_id)
 )`,

// ── academic_years ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='academic_years')
 CREATE TABLE academic_years (
   id         UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id  UNIQUEIDENTIFIER NOT NULL,
   name       NVARCHAR(100)    NOT NULL,
   start_date DATE             NOT NULL,
   end_date   DATE             NOT NULL,
   is_current BIT              NOT NULL DEFAULT(0),
   is_locked  BIT              NOT NULL DEFAULT(0),
   created_at DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at DATETIME2            NULL
 )`,

// ── grades ───────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='grades')
 CREATE TABLE grades (
   id            UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id     UNIQUEIDENTIFIER NOT NULL,
   name          NVARCHAR(100)    NOT NULL,
   numeric_order SMALLINT         NOT NULL,
   stream        VARCHAR(50)      NOT NULL DEFAULT('none'),
   description   NVARCHAR(500)        NULL,
   is_active     BIT              NOT NULL DEFAULT(1),
   created_at    DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at    DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at    DATETIME2            NULL
 )`,

// ── sections ─────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='sections')
 CREATE TABLE sections (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   grade_id         UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   name             NVARCHAR(50)     NOT NULL,
   room_number      NVARCHAR(50)         NULL,
   max_strength     SMALLINT         NOT NULL DEFAULT(40),
   class_teacher_id UNIQUEIDENTIFIER     NULL,
   is_active        BIT              NOT NULL DEFAULT(1),
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── subjects ─────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='subjects')
 CREATE TABLE subjects (
   id                   UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id            UNIQUEIDENTIFIER NOT NULL,
   name                 NVARCHAR(200)    NOT NULL,
   code                 NVARCHAR(50)         NULL,
   category             VARCHAR(50)      NOT NULL DEFAULT('core'),
   language_medium      NVARCHAR(50)         NULL DEFAULT('English'),
   is_theory            BIT              NOT NULL DEFAULT(1),
   is_practical         BIT              NOT NULL DEFAULT(0),
   theory_max_marks     SMALLINT             NULL DEFAULT(100),
   practical_max_marks  SMALLINT             NULL DEFAULT(0),
   passing_marks        SMALLINT             NULL DEFAULT(33),
   description          NVARCHAR(MAX)        NULL,
   is_active            BIT              NOT NULL DEFAULT(1),
   created_at           DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at           DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at           DATETIME2            NULL
 )`,

// ── students ─────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='students')
 CREATE TABLE students (
   id                 UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id          UNIQUEIDENTIFIER NOT NULL,
   user_id            UNIQUEIDENTIFIER     NULL,
   admission_no       NVARCHAR(100)    NOT NULL,
   roll_no            NVARCHAR(50)         NULL,
   first_name         NVARCHAR(100)    NOT NULL,
   middle_name        NVARCHAR(100)        NULL,
   last_name          NVARCHAR(100)    NOT NULL,
   gender             VARCHAR(20)      NOT NULL,
   date_of_birth      DATE             NOT NULL,
   blood_group        VARCHAR(10)          NULL,
   nationality        NVARCHAR(100)        NULL DEFAULT('Indian'),
   religion           NVARCHAR(100)        NULL,
   caste              NVARCHAR(100)        NULL,
   sub_caste          NVARCHAR(100)        NULL,
   is_ews             BIT              NOT NULL DEFAULT(0),
   aadhaar_no         NVARCHAR(20)         NULL,
   previous_school    NVARCHAR(255)        NULL,
   tc_no              NVARCHAR(100)        NULL,
   admission_date     DATE             NOT NULL,
   address_permanent  NVARCHAR(MAX)        NULL,
   address_current    NVARCHAR(MAX)        NULL,
   city               NVARCHAR(100)        NULL,
   state              NVARCHAR(100)        NULL,
   pincode            CHAR(6)              NULL,
   photo_url          NVARCHAR(MAX)        NULL,
   medical_conditions NVARCHAR(MAX)        NULL,
   disabilities       NVARCHAR(MAX)        NULL,
   extra_curricular   NVARCHAR(MAX)        NULL,
   is_active          BIT              NOT NULL DEFAULT(1),
   metadata           NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at         DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at         DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at         DATETIME2            NULL,
   UNIQUE(school_id, admission_no)
 )`,

// ── enrolments ───────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='enrolments')
 CREATE TABLE enrolments (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   student_id       UNIQUEIDENTIFIER NOT NULL,
   section_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   roll_no          NVARCHAR(50)         NULL,
   is_active        BIT              NOT NULL DEFAULT(1),
   promoted_from_id UNIQUEIDENTIFIER     NULL,
   remarks          NVARCHAR(MAX)        NULL,
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── student_guardians ────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='student_guardians')
 CREATE TABLE student_guardians (
   id                  UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id           UNIQUEIDENTIFIER NOT NULL,
   student_id          UNIQUEIDENTIFIER NOT NULL,
   user_id             UNIQUEIDENTIFIER     NULL,
   relation            NVARCHAR(50)     NOT NULL,
   full_name           NVARCHAR(255)    NOT NULL,
   phone               NVARCHAR(50)     NOT NULL,
   phone_alt           NVARCHAR(50)         NULL,
   email               NVARCHAR(255)        NULL,
   occupation          NVARCHAR(100)        NULL,
   annual_income_range NVARCHAR(100)        NULL,
   aadhaar_no          NVARCHAR(20)         NULL,
   is_primary          BIT              NOT NULL DEFAULT(0),
   is_emergency        BIT              NOT NULL DEFAULT(1),
   created_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at          DATETIME2            NULL
 )`,

// ── staff_profiles ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='staff_profiles')
 CREATE TABLE staff_profiles (
   id                      UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id               UNIQUEIDENTIFIER NOT NULL,
   member_id               UNIQUEIDENTIFIER NOT NULL,
   employee_code           NVARCHAR(100)    NOT NULL,
   designation             NVARCHAR(100)    NOT NULL,
   department              NVARCHAR(100)        NULL,
   qualification           NVARCHAR(255)    NOT NULL,
   specialisation          NVARCHAR(255)        NULL,
   experience_years        SMALLINT             NULL DEFAULT(0),
   date_of_joining         DATE             NOT NULL,
   date_of_birth           DATE                 NULL,
   pan_no                  NVARCHAR(50)         NULL,
   pf_no                   NVARCHAR(50)         NULL,
   esi_no                  NVARCHAR(50)         NULL,
   bank_account_no         NVARCHAR(100)        NULL,
   bank_ifsc               NVARCHAR(50)         NULL,
   bank_name               NVARCHAR(255)        NULL,
   salary_grade            NVARCHAR(50)         NULL,
   ctc_paise               BIGINT               NULL DEFAULT(0),
   address                 NVARCHAR(MAX)        NULL,
   emergency_contact_name  NVARCHAR(255)        NULL,
   emergency_contact_phone NVARCHAR(50)         NULL,
   is_class_teacher        BIT              NOT NULL DEFAULT(0),
   photo_url               NVARCHAR(MAX)        NULL,
   documents               NVARCHAR(MAX)        NULL DEFAULT('{}'),
   created_at              DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at              DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at              DATETIME2            NULL
 )`,

// ── student_attendance ───────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='student_attendance')
 CREATE TABLE student_attendance (
   id           UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id    UNIQUEIDENTIFIER NOT NULL,
   enrolment_id UNIQUEIDENTIFIER NOT NULL,
   student_id   UNIQUEIDENTIFIER NOT NULL,
   section_id   UNIQUEIDENTIFIER NOT NULL,
   date         DATE             NOT NULL,
   period_no    SMALLINT             NULL,
   status       VARCHAR(50)      NOT NULL DEFAULT('present'),
   marked_by    UNIQUEIDENTIFIER NOT NULL,
   marked_at    DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   note         NVARCHAR(MAX)        NULL,
   is_edited    BIT              NOT NULL DEFAULT(0),
   edited_by    UNIQUEIDENTIFIER     NULL,
   edited_at    DATETIME2            NULL,
   edit_reason  NVARCHAR(MAX)        NULL,
   created_at   DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at   DATETIME2            NULL
 )`,

// ── staff_attendance ─────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='staff_attendance')
 CREATE TABLE staff_attendance (
   id             UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id      UNIQUEIDENTIFIER NOT NULL,
   staff_id       UNIQUEIDENTIFIER NOT NULL,
   date           DATE             NOT NULL,
   status         VARCHAR(50)      NOT NULL DEFAULT('present'),
   check_in_time  TIME                 NULL,
   check_out_time TIME                 NULL,
   marked_by      UNIQUEIDENTIFIER     NULL,
   note           NVARCHAR(MAX)        NULL,
   created_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at     DATETIME2            NULL,
   UNIQUE(school_id, staff_id, date)
 )`,

// ── exams ────────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='exams')
 CREATE TABLE exams (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   name             NVARCHAR(255)    NOT NULL,
   exam_type        VARCHAR(50)      NOT NULL,
   grade_id         UNIQUEIDENTIFIER     NULL,
   start_date       DATE                 NULL,
   end_date         DATE                 NULL,
   is_published     BIT              NOT NULL DEFAULT(0),
   result_published BIT              NOT NULL DEFAULT(0),
   created_by       UNIQUEIDENTIFIER     NULL,
   instructions     NVARCHAR(MAX)        NULL,
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── exam_schedules ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='exam_schedules')
 CREATE TABLE exam_schedules (
   id                   UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id            UNIQUEIDENTIFIER NOT NULL,
   exam_id              UNIQUEIDENTIFIER NOT NULL,
   subject_id           UNIQUEIDENTIFIER NOT NULL,
   grade_id             UNIQUEIDENTIFIER NOT NULL,
   date                 DATE             NOT NULL,
   start_time           TIME                 NULL,
   end_time             TIME                 NULL,
   room_id              UNIQUEIDENTIFIER     NULL,
   invigilator_id       UNIQUEIDENTIFIER     NULL,
   max_theory_marks     SMALLINT         NOT NULL DEFAULT(100),
   max_practical_marks  SMALLINT         NOT NULL DEFAULT(0),
   passing_marks        SMALLINT         NOT NULL DEFAULT(33),
   created_at           DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at           DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at           DATETIME2            NULL
 )`,

// ── student_marks ────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='student_marks')
 CREATE TABLE student_marks (
   id                       UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id                UNIQUEIDENTIFIER NOT NULL,
   enrolment_id             UNIQUEIDENTIFIER NOT NULL,
   student_id               UNIQUEIDENTIFIER NOT NULL,
   exam_id                  UNIQUEIDENTIFIER NOT NULL,
   subject_id               UNIQUEIDENTIFIER NOT NULL,
   theory_marks_obtained    DECIMAL(5,2)         NULL,
   practical_marks_obtained DECIMAL(5,2)         NULL,
   is_absent                BIT              NOT NULL DEFAULT(0),
   is_exempted              BIT              NOT NULL DEFAULT(0),
   grade                    VARCHAR(50)          NULL,
   remarks                  NVARCHAR(MAX)        NULL,
   entered_by               UNIQUEIDENTIFIER NOT NULL,
   entered_at               DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   verified_by              UNIQUEIDENTIFIER     NULL,
   verified_at              DATETIME2            NULL,
   created_at               DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at               DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at               DATETIME2            NULL,
   UNIQUE(school_id, enrolment_id, exam_id, subject_id)
 )`,

// ── fee_components ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='fee_components')
 CREATE TABLE fee_components (
   id             UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id      UNIQUEIDENTIFIER NOT NULL,
   name           NVARCHAR(255)    NOT NULL,
   component_type VARCHAR(50)      NOT NULL,
   description    NVARCHAR(MAX)        NULL,
   is_recurring   BIT              NOT NULL DEFAULT(1),
   frequency      VARCHAR(50)          NULL DEFAULT('monthly'),
   is_taxable     BIT              NOT NULL DEFAULT(0),
   tax_percent    DECIMAL(5,2)         NULL DEFAULT(0),
   is_active      BIT              NOT NULL DEFAULT(1),
   created_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at     DATETIME2            NULL
 )`,

// ── fee_structures ───────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='fee_structures')
 CREATE TABLE fee_structures (
   id                  UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id           UNIQUEIDENTIFIER NOT NULL,
   academic_year_id    UNIQUEIDENTIFIER NOT NULL,
   grade_id            UNIQUEIDENTIFIER NOT NULL,
   component_id        UNIQUEIDENTIFIER NOT NULL,
   amount_paise        BIGINT           NOT NULL,
   due_day             SMALLINT             NULL DEFAULT(10),
   late_fee_paise      BIGINT               NULL DEFAULT(0),
   late_fee_after_days SMALLINT             NULL DEFAULT(0),
   is_active           BIT              NOT NULL DEFAULT(1),
   created_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at          DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at          DATETIME2            NULL
 )`,

// ── student_fee_accounts ─────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='student_fee_accounts')
 CREATE TABLE student_fee_accounts (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   student_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   total_fee_paise  BIGINT           NOT NULL DEFAULT(0),
   discount_paise   BIGINT           NOT NULL DEFAULT(0),
   scholarship_paise BIGINT          NOT NULL DEFAULT(0),
   net_fee_paise    BIGINT               NULL,
   paid_paise       BIGINT           NOT NULL DEFAULT(0),
   waived_paise     BIGINT           NOT NULL DEFAULT(0),
   pending_paise    BIGINT               NULL,
   status           VARCHAR(50)      NOT NULL DEFAULT('pending'),
   last_payment_date DATE                 NULL,
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL,
   UNIQUE(school_id, student_id, academic_year_id)
 )`,

// ── fee_invoices ─────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='fee_invoices')
 CREATE TABLE fee_invoices (
   id              UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id       UNIQUEIDENTIFIER NOT NULL,
   fee_account_id  UNIQUEIDENTIFIER NOT NULL,
   student_id      UNIQUEIDENTIFIER NOT NULL,
   invoice_no      NVARCHAR(100)    NOT NULL UNIQUE,
   invoice_date    DATE             NOT NULL,
   due_date        DATE             NOT NULL,
   period_label    NVARCHAR(100)    NOT NULL,
   subtotal_paise  BIGINT           NOT NULL DEFAULT(0),
   discount_paise  BIGINT           NOT NULL DEFAULT(0),
   late_fee_paise  BIGINT           NOT NULL DEFAULT(0),
   tax_paise       BIGINT           NOT NULL DEFAULT(0),
   total_paise     BIGINT           NOT NULL DEFAULT(0),
   paid_paise      BIGINT           NOT NULL DEFAULT(0),
   balance_paise   BIGINT               NULL,
   status          VARCHAR(50)      NOT NULL DEFAULT('pending'),
   notes           NVARCHAR(MAX)        NULL,
   created_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at      DATETIME2            NULL
 )`,

// ── fee_payments ─────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='fee_payments')
 CREATE TABLE fee_payments (
   id              UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id       UNIQUEIDENTIFIER NOT NULL,
   invoice_id      UNIQUEIDENTIFIER NOT NULL,
   fee_account_id  UNIQUEIDENTIFIER NOT NULL,
   student_id      UNIQUEIDENTIFIER NOT NULL,
   receipt_no      NVARCHAR(100)    NOT NULL UNIQUE,
   payment_date    DATE             NOT NULL,
   amount_paise    BIGINT           NOT NULL,
   payment_method  VARCHAR(50)      NOT NULL,
   transaction_ref NVARCHAR(255)        NULL,
   bank_name       NVARCHAR(255)        NULL,
   collected_by    UNIQUEIDENTIFIER NOT NULL,
   remarks         NVARCHAR(MAX)        NULL,
   is_void         BIT              NOT NULL DEFAULT(0),
   voided_by       UNIQUEIDENTIFIER     NULL,
   voided_at       DATETIME2            NULL,
   void_reason     NVARCHAR(MAX)        NULL,
   created_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at      DATETIME2            NULL
 )`,

// ── fee_concessions ──────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='fee_concessions')
 CREATE TABLE fee_concessions (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   student_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   concession_type  NVARCHAR(100)    NOT NULL,
   component_id     UNIQUEIDENTIFIER     NULL,
   discount_type    VARCHAR(50)      NOT NULL DEFAULT('percent'),
   discount_value   DECIMAL(10,2)    NOT NULL,
   approved_by      UNIQUEIDENTIFIER     NULL,
   remarks          NVARCHAR(MAX)        NULL,
   is_active        BIT              NOT NULL DEFAULT(1),
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── teacher_assignments ──────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='teacher_assignments')
 CREATE TABLE teacher_assignments (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   staff_id         UNIQUEIDENTIFIER NOT NULL,
   section_id       UNIQUEIDENTIFIER NOT NULL,
   subject_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   is_primary       BIT              NOT NULL DEFAULT(1),
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── timetables ───────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='timetables')
 CREATE TABLE timetables (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   section_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   effective_from   DATE             NOT NULL,
   effective_till   DATE                 NULL,
   is_active        BIT              NOT NULL DEFAULT(1),
   created_by       UNIQUEIDENTIFIER     NULL,
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── timetable_slots ──────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='timetable_slots')
 CREATE TABLE timetable_slots (
   id           UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id    UNIQUEIDENTIFIER NOT NULL,
   timetable_id UNIQUEIDENTIFIER NOT NULL,
   day_of_week  VARCHAR(20)      NOT NULL,
   period_no    SMALLINT         NOT NULL,
   start_time   TIME             NOT NULL,
   end_time     TIME             NOT NULL,
   subject_id   UNIQUEIDENTIFIER     NULL,
   teacher_id   UNIQUEIDENTIFIER     NULL,
   room_id      UNIQUEIDENTIFIER     NULL,
   is_break     BIT              NOT NULL DEFAULT(0),
   break_label  NVARCHAR(100)        NULL,
   created_at   DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at   DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at   DATETIME2            NULL
 )`,

// ── substitutions ────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='substitutions')
 CREATE TABLE substitutions (
   id                     UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id              UNIQUEIDENTIFIER NOT NULL,
   slot_id                UNIQUEIDENTIFIER NOT NULL,
   date                   DATE             NOT NULL,
   absent_teacher_id      UNIQUEIDENTIFIER NOT NULL,
   substitute_teacher_id  UNIQUEIDENTIFIER NOT NULL,
   reason                 NVARCHAR(MAX)        NULL,
   approved_by            UNIQUEIDENTIFIER     NULL,
   created_at             DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at             DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at             DATETIME2            NULL
 )`,

// ── quick_tests ──────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='quick_tests')
 CREATE TABLE quick_tests (
   id               UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id        UNIQUEIDENTIFIER NOT NULL,
   section_id       UNIQUEIDENTIFIER NOT NULL,
   subject_id       UNIQUEIDENTIFIER NOT NULL,
   teacher_id       UNIQUEIDENTIFIER NOT NULL,
   academic_year_id UNIQUEIDENTIFIER NOT NULL,
   title            NVARCHAR(255)    NOT NULL,
   topic            NVARCHAR(255)        NULL,
   date             DATE             NOT NULL,
   max_marks        SMALLINT         NOT NULL DEFAULT(20),
   duration_minutes SMALLINT             NULL,
   is_graded        BIT              NOT NULL DEFAULT(1),
   created_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at       DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at       DATETIME2            NULL
 )`,

// ── quick_test_results ───────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='quick_test_results')
 CREATE TABLE quick_test_results (
   id            UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id     UNIQUEIDENTIFIER NOT NULL,
   quick_test_id UNIQUEIDENTIFIER NOT NULL,
   student_id    UNIQUEIDENTIFIER NOT NULL,
   marks_obtained DECIMAL(5,2)        NULL,
   is_absent     BIT              NOT NULL DEFAULT(0),
   remarks       NVARCHAR(MAX)        NULL,
   created_at    DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at    DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at    DATETIME2            NULL
 )`,

// ── notices ──────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='notices')
 CREATE TABLE notices (
   id                UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id         UNIQUEIDENTIFIER NOT NULL,
   title             NVARCHAR(MAX)    NOT NULL,
   body              NVARCHAR(MAX)    NOT NULL,
   category          VARCHAR(50)      NOT NULL DEFAULT('general'),
   audience          VARCHAR(50)      NOT NULL DEFAULT('all'),
   target_grade_id   UNIQUEIDENTIFIER     NULL,
   target_section_id UNIQUEIDENTIFIER     NULL,
   is_published      BIT              NOT NULL DEFAULT(0),
   published_at      DATETIME2            NULL,
   expires_at        DATETIME2            NULL,
   attachment_urls   NVARCHAR(MAX)        NULL,
   created_by        UNIQUEIDENTIFIER NOT NULL,
   created_at        DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at        DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at        DATETIME2            NULL
 )`,

// ── homework ─────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='homework')
 CREATE TABLE homework (
   id              UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id       UNIQUEIDENTIFIER NOT NULL,
   section_id      UNIQUEIDENTIFIER NOT NULL,
   subject_id      UNIQUEIDENTIFIER NOT NULL,
   teacher_id      UNIQUEIDENTIFIER NOT NULL,
   title           NVARCHAR(255)    NOT NULL,
   description     NVARCHAR(MAX)        NULL,
   given_date      DATE             NOT NULL,
   due_date        DATE             NOT NULL,
   attachment_urls NVARCHAR(MAX)        NULL,
   is_graded       BIT              NOT NULL DEFAULT(0),
   max_marks       SMALLINT             NULL,
   created_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at      DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at      DATETIME2            NULL
 )`,

// ── homework_submissions ─────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='homework_submissions')
 CREATE TABLE homework_submissions (
   id             UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id      UNIQUEIDENTIFIER NOT NULL,
   homework_id    UNIQUEIDENTIFIER NOT NULL,
   student_id     UNIQUEIDENTIFIER NOT NULL,
   submitted_at   DATETIME2            NULL,
   submission_url NVARCHAR(MAX)        NULL,
   marks_obtained DECIMAL(5,2)         NULL,
   feedback       NVARCHAR(MAX)        NULL,
   status         VARCHAR(50)      NOT NULL DEFAULT('pending'),
   created_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at     DATETIME2            NULL
 )`,

// ── rooms ────────────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='rooms')
 CREATE TABLE rooms (
   id             UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id      UNIQUEIDENTIFIER NOT NULL,
   name           NVARCHAR(100)    NOT NULL,
   room_type      VARCHAR(50)      NOT NULL DEFAULT('classroom'),
   floor          NVARCHAR(50)         NULL,
   building       NVARCHAR(100)        NULL,
   capacity       SMALLINT             NULL,
   has_projector  BIT              NOT NULL DEFAULT(0),
   has_ac         BIT              NOT NULL DEFAULT(0),
   has_smartboard BIT              NOT NULL DEFAULT(0),
   is_active      BIT              NOT NULL DEFAULT(1),
   created_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   updated_at     DATETIME2        NOT NULL DEFAULT(GETUTCDATE()),
   deleted_at     DATETIME2            NULL
 )`,

// ── audit_logs ───────────────────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='audit_logs')
 CREATE TABLE audit_logs (
   id         UNIQUEIDENTIFIER NOT NULL DEFAULT(NEWID()) PRIMARY KEY,
   school_id  UNIQUEIDENTIFIER     NULL,
   actor_id   UNIQUEIDENTIFIER     NULL,
   actor_ip   VARCHAR(50)          NULL,
   action     NVARCHAR(50)     NOT NULL,
   table_name NVARCHAR(100)    NOT NULL,
   record_id  UNIQUEIDENTIFIER     NULL,
   old_values NVARCHAR(MAX)        NULL,
   new_values NVARCHAR(MAX)        NULL,
   diff       NVARCHAR(MAX)        NULL,
   user_agent NVARCHAR(MAX)        NULL,
   created_at DATETIME2        NOT NULL DEFAULT(GETUTCDATE())
 )`,

// ── Indexes for performance ──────────────────────────────────────────────
`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_students_school')
 CREATE INDEX IX_students_school ON students(school_id) WHERE deleted_at IS NULL`,

`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_enrolments_student')
 CREATE INDEX IX_enrolments_student ON enrolments(student_id, academic_year_id) WHERE deleted_at IS NULL`,

`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_student_att_date')
 CREATE INDEX IX_student_att_date ON student_attendance(school_id, section_id, date) WHERE deleted_at IS NULL`,

`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_student_marks_exam')
 CREATE INDEX IX_student_marks_exam ON student_marks(exam_id, student_id) WHERE deleted_at IS NULL`,

`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_fee_accounts_student')
 CREATE INDEX IX_fee_accounts_student ON student_fee_accounts(school_id, student_id) WHERE deleted_at IS NULL`,

`IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_audit_school_date')
 CREATE INDEX IX_audit_school_date ON audit_logs(school_id, created_at DESC)`,
];

async function runMigrations() {
  logger.info('🔄 Starting migrations...');
  const pool = await getPool();

  let success = 0;
  let failed  = 0;

  for (let i = 0; i < migrations.length; i++) {
    try {
      await pool.request().query(migrations[i]);
      logger.info(`  ✅ Migration ${i + 1}/${migrations.length} OK`);
      success++;
    } catch (err) {
      logger.error(`  ❌ Migration ${i + 1} FAILED: ${err.message}`);
      failed++;
    }
  }

  logger.info(`\n🎉 Migrations complete: ${success} succeeded, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runMigrations().catch((err) => {
  logger.error('Migration runner error:', err);
  process.exit(1);
});
