-- Source-only migration preparation for task B635C261. Do not apply through the legacy password rail.
-- Canonical @foritllc/mail 0.13.0 sql/email-optouts.sql SHA256 afce22e6c836bf7598a5eccf3e9dc36897d7ddcc00f06b995e650f964790763d
-- Requires the own-schema migration identity and applicable runtime-release authority.
:setvar APP_SCHEMA "interest"
:setvar APP_TABLE "EmailOptOuts"

-- EmailOptOuts — who switched which email off (@foritllc/mail unsubscribe store,
-- createSqlOptOutStore). The signed link, the RFC 8058 one-click POST, the account
-- page and the send-time check all read and write this one table.
--
-- Every app creates it in ITS OWN schema, never dbo (for-Common CLAUDE.md, "Azure and
-- database ground rules"). APP_SCHEMA and APP_TABLE are sqlcmd variables, filled the same
-- way as packages/db/templates/provision-app-principal.sql:
--
--   sqlcmd -b -v APP_SCHEMA=myapp APP_TABLE=EmailOptOuts -i email-optouts.sql
--
-- APP_TABLE is the name createSqlOptOutStore gets as `table` (default EmailOptOuts). Pass
-- another only when the schema already holds an unrelated EmailOptOuts (AvFees passes
-- APP_TABLE=EmailSwitches and table: 'EmailSwitches'). Both are required on the command
-- line: there is no :setvar default here, because sqlcmd ranks :setvar above -v and a default
-- in this file would override the caller's value (precedence, low to high: environment, -v,
-- :setvar; learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-use-scripting-variables). A
-- variable left undefined stops the script with an error. The constraint names carry the
-- table name, so two of these tables in one schema never collide.
--
-- The schema must already exist (provision-db-principal.yml creates it). Applied as a
-- logged run by the app's own migration identity, never by an agent
-- (docs/patterns/per-app-db-identity.md).
--
-- One row per (TenantKey, Subject, Category). OffAt NULL means on. Subject is
-- 'u:<userId>' or 'e:<first 32 hex of HMAC-SHA256(pepper, tenant + LF + address)>': the
-- address itself is never stored. The three key columns are binary-collated
-- (Latin1_General_100_BIN2), so keys compare exactly as the memory store compares them:
-- under a case-insensitive default, 'Tenant-A' would read and overwrite the row of 'tenant-a'.
--
-- The guards and the CREATE are one batch: THROW ends the batch, so a refused APP_SCHEMA or
-- APP_TABLE creates nothing even when sqlcmd runs without -b (which moves on to the next batch
-- after an error). -b also makes the refusal exit non-zero.

SET NOCOUNT ON;

IF N'$(APP_SCHEMA)' = N'' OR LOWER(N'$(APP_SCHEMA)') = N'dbo'
    THROW 50301, 'APP_SCHEMA must be the app''s own schema, never dbo.', 1;
IF SCHEMA_ID(N'$(APP_SCHEMA)') IS NULL
    THROW 50302, 'APP_SCHEMA does not exist; create the schema first (provision-db-principal.yml).', 1;
-- The same name rule createSqlOptOutStore applies to `table`: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.
IF N'$(APP_TABLE)' COLLATE Latin1_General_100_BIN2 NOT LIKE N'[A-Za-z]%'
   OR N'$(APP_TABLE)' COLLATE Latin1_General_100_BIN2 LIKE N'%[^A-Za-z0-9_]%'
   OR LEN(N'$(APP_TABLE)') > 64
    THROW 50303, 'APP_TABLE must be the table name createSqlOptOutStore is given (default EmailOptOuts): a letter, then letters, digits or _, at most 64.', 1;

IF OBJECT_ID(N'[$(APP_SCHEMA)].[$(APP_TABLE)]', N'U') IS NULL
BEGIN
    CREATE TABLE [$(APP_SCHEMA)].[$(APP_TABLE)] (
        TenantKey  NVARCHAR(64)  COLLATE Latin1_General_100_BIN2 NOT NULL,  -- the tenant the link was minted for
        Subject    VARCHAR(80)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- 'u:<userId>' | 'e:<hash>'
        Category   VARCHAR(64)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- lower-case kebab-case switch, e.g. 'job-alerts'
        OffAt      DATETIME2     NULL,                      -- first switched off; NULL = on
        Source     VARCHAR(16)   NOT NULL,                  -- who flipped it last
        UpdatedAt  DATETIME2     NOT NULL CONSTRAINT [DF_$(APP_TABLE)_UpdatedAt] DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT [PK_$(APP_TABLE)] PRIMARY KEY (TenantKey, Subject, Category),
        CONSTRAINT [CK_$(APP_TABLE)_Source] CHECK (Source IN ('link', 'one-click', 'account', 'admin'))
    );
END
GO
