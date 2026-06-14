-- ============================================================================
-- PARA-FORM — USER PROJECTS + AI CHATS  (TESTING SCHEMA)
-- ============================================================================
-- Run this in your existing ParaForm Supabase project's SQL Editor.
-- Idempotent + re-runnable. Stores the user's saved documents (the library),
-- their folders, and their AI chat sessions so they sync across devices.
--
-- IDs are TEXT (client-generated: doc_*, fld_*, chat_*) so the browser store
-- and the cloud row share the same id — no id remapping. Access is locked to
-- the owner via RLS (auth.uid() = user_id); the browser talks to these tables
-- directly with the user's JWT (no service role needed).
--
-- NOTE: for testing use. Document JSON + base64 thumbnails are stored inline in
-- JSONB/TEXT columns (simple, no storage bucket). Fine for dev; for production
-- you'd likely move large docs/thumbnails to Supabase Storage.
-- ============================================================================

-- ── updated_at helper ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- ── 1. Folders ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cad_folders (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT 'New folder',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cad_folders_user ON cad_folders (user_id);

-- ── 2. Documents (the library) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cad_documents (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    folder_id   TEXT REFERENCES cad_folders(id) ON DELETE SET NULL,
    name        TEXT NOT NULL DEFAULT 'Untitled',
    doc         JSONB NOT NULL,            -- store.toJSON() snapshot (v5 document)
    thumb       TEXT,                      -- optional iso-view thumbnail (data URL)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cad_documents_user   ON cad_documents (user_id);
CREATE INDEX IF NOT EXISTS idx_cad_documents_folder ON cad_documents (folder_id);

-- ── 3. AI chats ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_chats (
    id           TEXT PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    document_id  TEXT REFERENCES cad_documents(id) ON DELETE SET NULL, -- optional: chat ↔ doc
    title        TEXT NOT NULL DEFAULT 'New chat',
    items        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- rendered transcript
    history      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- provider neutral history
    auto_mode    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_chats_doc  ON ai_chats (document_id);

-- ── updated_at triggers (idempotent) ────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_cad_folders_updated   ON cad_folders;
CREATE TRIGGER trg_cad_folders_updated   BEFORE UPDATE ON cad_folders
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_cad_documents_updated ON cad_documents;
CREATE TRIGGER trg_cad_documents_updated BEFORE UPDATE ON cad_documents
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_chats_updated      ON ai_chats;
CREATE TRIGGER trg_ai_chats_updated      BEFORE UPDATE ON ai_chats
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row Level Security: owner-only ──────────────────────────────────────────
ALTER TABLE cad_folders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cad_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chats      ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cad_folders_owner_all') THEN
        CREATE POLICY "cad_folders_owner_all" ON cad_folders
            FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cad_documents_owner_all') THEN
        CREATE POLICY "cad_documents_owner_all" ON cad_documents
            FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'ai_chats_owner_all') THEN
        CREATE POLICY "ai_chats_owner_all" ON ai_chats
            FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;

-- ── Done. The browser (lib/cloud_projects.js) reads/writes these directly with
--    the signed-in user's JWT; RLS guarantees a user only ever sees their own
--    rows. No service-role key required for this feature.
