import { createClient } from '@supabase/supabase-js';

// These should ideally be environment variables in a real production environment
// For this Phase 1 setup, we will use placeholders that the user can replace
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project-id.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
