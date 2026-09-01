import { createClient } from '@supabase/supabase-js';
export const SUPABASE_URL = 'https://yyitlucbkpevpyrkoecu.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5aXRsdWNia3BldnB5cmtvZWN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3ODE5MDAsImV4cCI6MjEwMzM1NzkwMH0.rB0U1WB_T3AEaNiCfntCaEecz30bnc4S1ozc5go8xts';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
export async function pushLiveLocation({ userId, latitude, longitude, heading, speed, accuracy }) {
  return supabase
    .from('live_locations')
    .upsert(
      {
        user_id: userId,
        latitude,
        longitude,
        heading,
        speed,
        accuracy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
}
export function subscribeToLiveLocations(onChange) {
  const channel = supabase
    .channel('live-locations')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'live_locations' },
      (payload) => onChange(payload)
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
