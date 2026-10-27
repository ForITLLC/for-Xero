-- Source-only migration preparation for task B635C261. DO NOT apply through the legacy password migration rail.
-- Canonical @foritllc/mail 0.6.0 sql/email-optouts.sql SHA256 cc5e333cd66eeabdd5926bc1a3266f68235bcc760cc65aae678a8688125a51da
-- Requires an approved own-schema migration identity and the existing Interest deployment hold to be resolved.
:setvar APP_SCHEMA "interest"

-- EmailOptOuts — who switched which email off (@foritllc/mail unsubscribe store,
-- createSqlOptOutStore). The signed link, the RFC 8058 one-click POST, the account
-- page and the send-time check all read and write this one table.
--
-- Every app creates it in ITS OWN schema, never dbo (for-Common CLAUDE.md, "Azure and
-- database ground rules"). APP_SCHEMA is a sqlcmd variable, filled the same way as
-- packages/db/templates/provision-app-principal.sql (sqlcmd -v APP_SCHEMA=myapp).
-- The schema must already exist (provision-db-principal.yml creates it). Applied as a
-- logged run by the app's own migration identity, never by an agent
-- (docs/patterns/per-app-db-identity.md).
--
-- One row per (TenantKey, Subject, Category). OffAt NULL means on. Subject is
-- 'u:<userId>' or 'e:<first 32 hex of HMAC-SHA256(pepper, tenant + LF + address)>': the
-- address itself is never stored. The three key columns are binary-collated
-- (Latin1_General_100_BIN2), so keys compare exactly as the memory store compares them:
-- under a case-insensitive default, 'Tenant-A' would read and overwrite the row of 'tenant-a'.

SET NOCOUNT ON;

IF N'$(APP_SCHEMA)' = N'' OR LOWER(N'$(APP_SCHEMA)') = N'dbo'
    THROW 50301, 'APP_SCHEMA must be the app''s own schema, never dbo.', 1;
IF SCHEMA_ID(N'$(APP_SCHEMA)') IS NULL
    THROW 50302, 'APP_SCHEMA does not exist; create the schema first (provision-db-principal.yml).', 1;
GO

IF OBJECT_ID(N'[$(APP_SCHEMA)].[EmailOptOuts]', N'U') IS NULL
BEGIN
    CREATE TABLE [$(APP_SCHEMA)].[EmailOptOuts] (
        TenantKey  NVARCHAR(64)  COLLATE Latin1_General_100_BIN2 NOT NULL,  -- the tenant the link was minted for
        Subject    VARCHAR(80)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- 'u:<userId>' | 'e:<hash>'
        Category   VARCHAR(64)   COLLATE Latin1_General_100_BIN2 NOT NULL,  -- lower-case kebab-case switch, e.g. 'job-alerts'
        OffAt      DATETIME2     NULL,                      -- first switched off; NULL = on
        Source     VARCHAR(16)   NOT NULL,                  -- who flipped it last
        UpdatedAt  DATETIME2     NOT NULL CONSTRAINT DF_EmailOptOuts_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_EmailOptOuts PRIMARY KEY (TenantKey, Subject, Category),
        CONSTRAINT CK_EmailOptOuts_Source CHECK (Source IN ('link', 'one-click', 'account', 'admin'))
    );
END
GO
