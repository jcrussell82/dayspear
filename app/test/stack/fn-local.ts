// @ts-nocheck — TEST ONLY: serves the `api` Edge Function on a fixed port, as Supabase would.
import { handle } from '../../supabase/functions/api/app.js';
Deno.serve({ port: 54340, hostname: '127.0.0.1', onListen() {} }, handle);
