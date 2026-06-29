import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://tidranrgxcgogirputbz.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpZHJhbnJneGNnb2dpcnB1dGJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MjE3NTMsImV4cCI6MjA5ODA5Nzc1M30.rVbiV-gzqs2cK9LtGwgKduT2iExmavz3rHIlK6bYZO4'
export const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null
export const isSupabaseReady = !!supabaseKey
