import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project-id.supabase.co';

// Accept either the new Supabase publishable key (sb_publishable_...) or the
// legacy anon key (VITE_SUPABASE_ANON_KEY). Both are functionally identical —
// Supabase renamed "anon key" to "publishable key" in their newer dashboard UI.
const supabaseKey =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    'your-anon-key';

export const supabase = createClient(supabaseUrl, supabaseKey);
