# Supabase setup

1. Make sure the project URL in `.env.local` is the same Supabase project whose
   SQL Editor you are using. Run the migrations in
   `supabase/migrations` in filename order:
   `202611170001_initial_schema.sql`,
   `202611180001_inventory_foundations.sql`,
   `202611180002_admin_bootstrap.sql`,
   `202611200001_team_invitations.sql`,
   `202611200002_product_catalog_details.sql`, and
   `202611210001_customer_accounts_and_orders.sql` (or use the Supabase CLI to
   apply migrations). Apply the customer migration before running the updated
   frontend: it adds customer accounts, purchase history, and customer orders.
   The base migration safely fills in missing workspace columns
   for an existing `public.profiles` table and retains its user rows. Profiles
   that are not already linked to a valid organization and branch are assigned
   their own organization and main branch. Do not drop `profiles` or its users.
   If a previous attempt stopped because `profiles` already existed, run the
   updated base migration again, then run the remaining migrations. If the app
   reports that the bootstrap function is missing from the schema cache after
   applying the migration, run `NOTIFY pgrst, 'reload schema';` in the SQL
   Editor and wait a few seconds.
2. In **Project Settings → API**, copy the Project URL and the publishable key.
   Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Keep Supabase email/password authentication enabled. Set the site URL and
   allowed redirect URLs for your local and deployed app in **Authentication →
   URL Configuration**.
   The interface language selector is available on the sign-in screen and in
   the application header. English and Amharic are supported, and the browser
   remembers the selected language. Dates, numbers, and currency displays use
   the selected language's regional formatting and the organization's currency.
4. Run `npm run dev`. If there are no existing profiles, in Supabase Dashboard
   open **Authentication → Users → Add user** and create the initial
   administrator with the email and password you want to use. Confirm the
   email if prompted. The database trigger creates the organization, admin
   profile, and first branch. If you already had a profile, sign in with that
   existing account instead.
5. Deploy `supabase/functions/team-members/index.ts` as the `team-members`
   Edge Function. Keep gateway JWT verification disabled as configured in
   `supabase/config.toml` so unauthenticated CORS preflight requests can reach
   the function; it independently validates each bearer token with Supabase
   Auth and checks the caller's administrator profile. Configure
   `SUPABASE_SERVICE_ROLE_KEY` as an Edge Function secret (never as a `VITE_`
   variable), then deploy the function. For example, with the Supabase CLI
   linked to this project, run `supabase functions deploy team-members` and
   `supabase secrets set "SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY"`,
   replacing the placeholder with the service-role key from Project Settings →
   API.
   The function validates the caller's session and administrator profile before
   inviting, assigning, editing, removing, or listing team members. Select an
   active branch before inviting a non-admin user. The database invitation
   trigger accepts new profiles only from its private, one-use invite queue.
   The invited user receives a secure email, chooses their own password in the
   app, and signs in to a workspace scoped to their assigned branch. Admins can
   view all branches; other roles are restricted to their assigned branch.
   The product catalog migration adds the secure product-creation RPC used by
   the admin form. It can generate a SKU when one is not supplied and saves
   device details and opening inventory for the selected branch together.
   The customer accounts migration adds public customer signup and login, a
   customer portal for catalog browsing, purchase history, and branch order
   requests. Customers select a business during signup and choose an active
   branch when requesting an order. Orders remain requests until branch staff
   confirms availability; inventory is not reserved, and payment is handled
   offline when staff completes the order in the POS. The resulting sale is
   linked to the customer's purchase history and stock is deducted using the
   normal sale workflow.

The browser uses only the publishable (or legacy anon) key. Row Level Security
and database functions enforce organization and branch access; never put a
service-role/secret key in a `VITE_` variable or browser code. Apply schema
changes through versioned migrations and back up production data before
deploying schema updates.
