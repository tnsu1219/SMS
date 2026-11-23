# Rodas Smart Sales Management

## Project structure

- `frontend/` - React and Vite user interface
- `backend/` - Supabase Edge Functions
- `database/` - versioned SQL migrations
- `docs/` - setup and deployment documentation

## Run the frontend

```powershell
cd frontend
npm install
npm run dev
```

## Build the frontend

```powershell
cd frontend
npm run build
```

## Database and backend

- Apply files in `database/migrations/` to Supabase in filename order.
- Deploy the function in `backend/supabase/functions/team-members/`.
- Backend and database setup details are in `docs/SUPABASE_SETUP.md`.
