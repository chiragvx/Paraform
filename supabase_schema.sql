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

-- ============================================================
-- PHASE 2: AUTH GATE — plans + per-user daily usage caps
-- Consumed by the kernel server (b123d_server/auth_gate.py).
-- Idempotent: safe to re-run in the Supabase SQL Editor.
-- ============================================================

-- 6. User plans
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'maker', 'lifetime')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Owner can read their own profile. No INSERT/UPDATE/DELETE policies on
-- purpose: rows are created by the auth trigger below (security definer)
-- and `plan` may only be changed by the service role, which bypasses RLS.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'profiles_owner_read') THEN
        CREATE POLICY "profiles_owner_read" ON profiles FOR SELECT USING (auth.uid() = id);
    END IF;
END $$;

-- Auto-create a profile row for every new auth user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id) VALUES (NEW.id)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. Daily usage counters (one row per user / UTC day / kind)
CREATE TABLE IF NOT EXISTS usage_daily (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    kind TEXT NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, kind)
);

ALTER TABLE usage_daily ENABLE ROW LEVEL SECURITY;

-- Owner may read their own usage (e.g. a "12/15 AI calls today" meter).
-- No write policies: all writes go through increment_usage() below.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'usage_owner_read') THEN
        CREATE POLICY "usage_owner_read" ON usage_daily FOR SELECT USING (auth.uid() = user_id);
    END IF;
END $$;

-- 8. Atomic upsert-and-increment; returns the new count for the bucket.
CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id UUID, p_day DATE, p_kind TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_count INT;
BEGIN
    INSERT INTO public.usage_daily (user_id, day, kind, count)
    VALUES (p_user_id, p_day, p_kind, 1)
    ON CONFLICT (user_id, day, kind)
    DO UPDATE SET count = usage_daily.count + 1
    RETURNING count INTO new_count;
    RETURN new_count;
END;
$$;

-- Only the kernel (service role) may bump counters — not anon/authenticated.
REVOKE ALL ON FUNCTION public.increment_usage(UUID, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_usage(UUID, DATE, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(UUID, DATE, TEXT) TO service_role;
