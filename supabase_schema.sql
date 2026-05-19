-- PARA-FORM DATABASE SCHEMA (PHASE 1)
-- Run this in your Supabase SQL Editor

-- 1. Public catalog of templates
CREATE TABLE IF NOT EXISTS base_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    config_payload JSONB NOT NULL,
    is_published BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexing for search performance
CREATE INDEX IF NOT EXISTS idx_templates_category ON base_templates (category) WHERE is_published;

-- 2. User-saved configurations
CREATE TABLE IF NOT EXISTS user_creations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES base_templates(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    saved_parameters JSONB NOT NULL,
    thumbnail_url TEXT,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creations_user ON user_creations (user_id);
CREATE INDEX IF NOT EXISTS idx_creations_template ON user_creations (template_id);

-- 3. Security (RLS)
ALTER TABLE base_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_creations ENABLE ROW LEVEL SECURITY;

-- 4. Policies
-- Everyone can read published templates
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'templates_public_read') THEN
        CREATE POLICY "templates_public_read" ON base_templates FOR SELECT USING (is_published);
    END IF;
END $$;

-- Users can manage their own creations
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'creations_owner_all') THEN
        CREATE POLICY "creations_owner_all" ON user_creations FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
    END IF;
END $$;

-- 5. Storage (Bucket for Thumbnails)
-- Note: Buckets can't always be created via pure SQL in all Supabase envs, 
-- but these policies ensure security once the 'thumbnails' bucket exists.

INSERT INTO storage.buckets (id, name, public) 
VALUES ('thumbnails', 'thumbnails', true)
ON CONFLICT (id) DO NOTHING;

-- Policies for storage
CREATE POLICY "Public Thumbnail Read" ON storage.objects 
  FOR SELECT USING (bucket_id = 'thumbnails');

CREATE POLICY "Authenticated Thumbnail Upload" ON storage.objects 
  FOR INSERT WITH CHECK (
    bucket_id = 'thumbnails' AND 
    auth.role() = 'authenticated'
  );
