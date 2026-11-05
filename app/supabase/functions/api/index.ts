// @ts-nocheck — the function is written in plain JavaScript modules.
// Entry point Supabase runs for https://<project>.supabase.co/functions/v1/api/...
import { handle } from './app.js';

Deno.serve(handle);
