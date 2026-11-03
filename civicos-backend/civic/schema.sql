CREATE SCHEMA IF NOT EXISTS civic;

CREATE TABLE IF NOT EXISTS civic.portals (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  domain text UNIQUE,
  name text NOT NULL,
  settings jsonb NOT NULL,
  archived_at timestamptz
);
ALTER TABLE civic.portals ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE TABLE IF NOT EXISTS civic.config (
  tenant_id uuid PRIMARY KEY REFERENCES civic.portals(id),
  roles jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS civic.members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES civic.portals(id),
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  password_hash text,
  supabase_user_id uuid,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);
ALTER TABLE civic.members ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE civic.members ADD COLUMN IF NOT EXISTS supabase_user_id uuid;
ALTER TABLE civic.members ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
UPDATE civic.members
  SET display_name = initcap(replace(replace(split_part(email, '@', 1), '.', ' '), '_', ' '))
  WHERE display_name = '';
UPDATE civic.members SET password_hash = NULL WHERE password_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS civic_members_supabase_user
  ON civic.members(tenant_id, supabase_user_id) WHERE supabase_user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS civic.records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES civic.portals(id),
  kind text NOT NULL CHECK (kind IN ('request', 'service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure')),
  title text NOT NULL,
  description text NOT NULL,
  location text NOT NULL DEFAULT '',
  category text,
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  published boolean NOT NULL DEFAULT false,
  status text,
  reference text UNIQUE,
  contact jsonb,
  photo text,
  photos text[] NOT NULL DEFAULT '{}',
  field_photo text,
  field_photos text[] NOT NULL DEFAULT '{}',
  url text,
  assigned_to uuid,
  archived_at timestamptz,
  archived_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES civic.members(tenant_id, id),
  FOREIGN KEY (tenant_id, archived_by) REFERENCES civic.members(tenant_id, id),
  CHECK ((longitude IS NULL) = (latitude IS NULL)),
  CONSTRAINT records_photo_limit_check CHECK (cardinality(photos) <= 3 AND cardinality(field_photos) <= 3)
);
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS archived_by uuid;
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS calendar_date date;
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS field_photo text;
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS photos text[] NOT NULL DEFAULT '{}';
UPDATE civic.records SET photos = ARRAY[photo]
  WHERE photo IS NOT NULL AND cardinality(photos) = 0;
ALTER TABLE civic.records ADD COLUMN IF NOT EXISTS field_photos text[] NOT NULL DEFAULT '{}';
UPDATE civic.records SET field_photos = ARRAY[field_photo]
  WHERE field_photo IS NOT NULL AND cardinality(field_photos) = 0;
DO $$
DECLARE old_constraint record;
BEGIN
  FOR old_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'civic.records'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'cardinality\(photos\).*\+.*cardinality\(field_photos\)'
  LOOP
    EXECUTE format('ALTER TABLE civic.records DROP CONSTRAINT %I', old_constraint.conname);
  END LOOP;
END $$;
ALTER TABLE civic.records DROP CONSTRAINT IF EXISTS records_photo_limit_check;
ALTER TABLE civic.records ADD CONSTRAINT records_photo_limit_check
  CHECK (cardinality(photos) <= 3 AND cardinality(field_photos) <= 3);
ALTER TABLE civic.records DROP CONSTRAINT IF EXISTS records_tenant_id_archived_by_fkey;
ALTER TABLE civic.records ADD CONSTRAINT records_tenant_id_archived_by_fkey
  FOREIGN KEY (tenant_id, archived_by) REFERENCES civic.members(tenant_id, id);
CREATE TABLE IF NOT EXISTS civic.history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor uuid,
  previous_status text,
  new_status text NOT NULL,
  notes text NOT NULL DEFAULT '',
  actor_role text,
  note_visibility text NOT NULL DEFAULT 'role_only' CHECK (note_visibility IN ('role_only', 'down_chain')),
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, request_id) REFERENCES civic.records(tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES civic.members(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES civic.members(tenant_id, id)
);
ALTER TABLE civic.history ADD COLUMN IF NOT EXISTS actor_role text;
ALTER TABLE civic.history ADD COLUMN IF NOT EXISTS note_visibility text NOT NULL DEFAULT 'role_only';
ALTER TABLE civic.history DROP CONSTRAINT IF EXISTS history_note_visibility_check;
ALTER TABLE civic.history ADD CONSTRAINT history_note_visibility_check
  CHECK (note_visibility IN ('role_only', 'down_chain'));
CREATE TABLE IF NOT EXISTS civic.chat_channels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES civic.portals(id),
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  description text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES civic.members(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS civic.chat_direct_threads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES civic.portals(id),
  member_low uuid NOT NULL,
  member_high uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, member_low, member_high),
  CHECK (member_low < member_high),
  FOREIGN KEY (tenant_id, member_low) REFERENCES civic.members(tenant_id, id),
  FOREIGN KEY (tenant_id, member_high) REFERENCES civic.members(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS civic.chat_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel_id uuid,
  direct_thread_id uuid,
  sender_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((channel_id IS NOT NULL)::integer + (direct_thread_id IS NOT NULL)::integer = 1),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES civic.chat_channels(tenant_id, id),
  FOREIGN KEY (tenant_id, direct_thread_id) REFERENCES civic.chat_direct_threads(tenant_id, id),
  FOREIGN KEY (tenant_id, sender_id) REFERENCES civic.members(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS records_tenant_kind ON civic.records(tenant_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS records_active_requests ON civic.records(tenant_id, status, created_at DESC)
  WHERE kind = 'request' AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS history_request ON civic.history(tenant_id, request_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_channel_cursor ON civic.chat_messages(tenant_id, channel_id, created_at, id);
CREATE INDEX IF NOT EXISTS chat_messages_direct_cursor ON civic.chat_messages(tenant_id, direct_thread_id, created_at, id);

INSERT INTO civic.chat_channels (id, tenant_id, name, description)
SELECT gen_random_uuid(), id, 'general', 'Organization-wide staff chat'
FROM civic.portals
ON CONFLICT (tenant_id, name) DO NOTHING;

UPDATE civic.config SET roles = roles || jsonb_build_object('admin',
  CASE WHEN COALESCE(roles->'admin', '[]'::jsonb) @> '["chat"]'::jsonb THEN roles->'admin'
    ELSE COALESCE(roles->'admin', '[]'::jsonb) || '"chat"'::jsonb END)
WHERE roles ? 'admin';
UPDATE civic.config SET roles = roles || jsonb_build_object('staff',
  CASE WHEN COALESCE(roles->'staff', '[]'::jsonb) @> '["chat"]'::jsonb THEN roles->'staff'
    ELSE COALESCE(roles->'staff', '[]'::jsonb) || '"chat"'::jsonb END)
WHERE roles ? 'staff';
UPDATE civic.config SET roles = roles || jsonb_build_object('field',
  CASE WHEN COALESCE(roles->'field', '[]'::jsonb) @> '["chat"]'::jsonb THEN roles->'field'
    ELSE COALESCE(roles->'field', '[]'::jsonb) || '"chat"'::jsonb END)
WHERE roles ? 'field';

ALTER TABLE civic.portals ENABLE ROW LEVEL SECURITY;
ALTER TABLE civic.portals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_read ON civic.portals;
CREATE POLICY portal_read ON civic.portals FOR SELECT USING (true);
DROP POLICY IF EXISTS portal_update ON civic.portals;
CREATE POLICY portal_update ON civic.portals FOR UPDATE
  USING (id::text = current_setting('civic.tenant', true))
  WITH CHECK (id::text = current_setting('civic.tenant', true));
DROP POLICY IF EXISTS portal_platform_insert ON civic.portals;
CREATE POLICY portal_platform_insert ON civic.portals FOR INSERT
  WITH CHECK (current_setting('civic.platform_admin', true) = 'true');
DROP POLICY IF EXISTS portal_platform_delete ON civic.portals;
CREATE POLICY portal_platform_delete ON civic.portals FOR DELETE
  USING (id::text = current_setting('civic.tenant', true)
    AND current_setting('civic.platform_admin', true) = 'true');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['config', 'members', 'records', 'history', 'chat_channels', 'chat_direct_threads', 'chat_messages'] LOOP
    EXECUTE format('ALTER TABLE civic.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE civic.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON civic.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON civic.%I USING (tenant_id::text = current_setting(''civic.tenant'', true)) WITH CHECK (tenant_id::text = current_setting(''civic.tenant'', true))', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS history_platform_delete ON civic.history;
CREATE POLICY history_platform_delete ON civic.history AS RESTRICTIVE FOR DELETE
  USING (current_setting('civic.platform_admin', true) = 'true');

DROP POLICY IF EXISTS chat_thread_participant ON civic.chat_direct_threads;
DROP POLICY IF EXISTS tenant_isolation ON civic.chat_direct_threads;
CREATE POLICY chat_thread_participant ON civic.chat_direct_threads FOR ALL
  USING (tenant_id::text = current_setting('civic.tenant', true) AND (
    current_setting('civic.platform_admin', true) = 'true'
    OR current_setting('civic.member', true) IN (member_low::text, member_high::text)))
  WITH CHECK (tenant_id::text = current_setting('civic.tenant', true)
    AND (current_setting('civic.platform_admin', true) = 'true'
      OR current_setting('civic.member', true) IN (member_low::text, member_high::text)));
DROP POLICY IF EXISTS chat_message_access ON civic.chat_messages;
DROP POLICY IF EXISTS tenant_isolation ON civic.chat_messages;
CREATE POLICY chat_message_access ON civic.chat_messages FOR ALL
  USING (tenant_id::text = current_setting('civic.tenant', true) AND (
    current_setting('civic.platform_admin', true) = 'true'
    OR (channel_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM civic.chat_direct_threads thread
      WHERE thread.tenant_id = chat_messages.tenant_id
        AND thread.id = chat_messages.direct_thread_id
        AND current_setting('civic.member', true) IN (thread.member_low::text, thread.member_high::text)
    ))))
  WITH CHECK (tenant_id::text = current_setting('civic.tenant', true)
    AND (current_setting('civic.platform_admin', true) = 'true' OR (
      sender_id::text = current_setting('civic.member', true)
      AND (channel_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM civic.chat_direct_threads thread
      WHERE thread.tenant_id = chat_messages.tenant_id
        AND thread.id = chat_messages.direct_thread_id
        AND current_setting('civic.member', true) IN (thread.member_low::text, thread.member_high::text)
    )))));

GRANT USAGE ON SCHEMA civic TO civic_app;
GRANT SELECT, INSERT, UPDATE ON civic.portals TO civic_app;
GRANT SELECT, INSERT, UPDATE ON civic.config, civic.members, civic.records TO civic_app;
GRANT SELECT, INSERT ON civic.history TO civic_app;
GRANT SELECT, INSERT ON civic.chat_channels, civic.chat_direct_threads, civic.chat_messages TO civic_app;
REVOKE UPDATE, DELETE, TRUNCATE ON civic.history FROM civic_app;
GRANT DELETE ON civic.portals, civic.config, civic.members, civic.records, civic.history,
  civic.chat_channels, civic.chat_direct_threads, civic.chat_messages TO civic_app;
