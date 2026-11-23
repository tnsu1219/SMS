# Backend

The backend is a Supabase Edge Function project.

## Team management function

The function is at [supabase/functions/team-members/index.ts](supabase/functions/team-members/index.ts).

Deploy with the Supabase CLI:

```powershell
cd backend
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest functions deploy team-members
npx supabase@latest secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

The service-role key must be a Supabase secret. Never place it in `frontend/.env.local`
or any `VITE_` variable.
