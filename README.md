# Oceanic Lab Workflow on Netlify + Supabase

The doctor's Apps Script ELN/LIMS app, moved off Google so it runs as a normal website:

| Before (Apps Script)            | Now                                                        |
|---------------------------------|------------------------------------------------------------|
| `Index.html` served by Apps Script | `public/index.html` served by **Netlify** (same screens) |
| `Code.gs` server functions      | `netlify/functions/api.mjs` + `lib/core.mjs` (same rules)  |
| Google Sheet (3 tabs)           | **Supabase Postgres**: `entries`, `requests`, `samples`    |
| (none)                          | `audit_log`: every version of every record, append-only    |
| Google Drive folders            | **Supabase Storage** bucket `lab-files` (same folder layout) |
| Google account sign-in          | **Supabase Auth**: email + password, or emailed sign-in link |

```
Browser ──(sign in)──────────────► Supabase Auth
   │
   ├──POST /api  (with sign-in token)──► Netlify Function ──(secret key)──► Supabase Postgres + Storage
   │                                       checks user, status locks,
   │                                       versions, independent review,
   │                                       makes the PDFs
   └──file upload (one-time slot from /api)──► Supabase Storage
```

The browser never touches the database directly. Tables are locked with row-level security,
and only the Netlify function, which holds the secret key, can read or write them, after it has
checked who the user is. All the workflow rules from `Code.gs` are kept: Draft → Submitted → Signed,
reopen with a reason, the four checks, the "someone else changed this record" guard,
sample receipt, results, approve, issue the report, and the ID formats
(`CHEM-2026-0001`, `SR-…`, `ANA-…`, `…-S01`).

---

## Setup (about 20 minutes)

### 1. Supabase: database, files, users

1. Go to [supabase.com](https://supabase.com), choose **New project**. Pick the **Mumbai (ap-south-1)** region
   so lab data stays in India. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and choose **Run**.
   This creates the 4 tables, locks them down, and creates the private `lab-files` bucket.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up",
   so only people you add can get in.
4. **Authentication → Users → Add user → Create new user**: add each lab member with an email and a
   temporary password, and tick **Auto Confirm User**. Use at least 2 people so one can review the other's work.
5. **Project Settings → API Keys**: copy the **Project URL**, the **anon / publishable** key, and the
   **service_role / secret** key. Keep the secret key private: never put it in the web page or in Git.

### 2. Netlify: website + server function

Netlify's drag-and-drop deploy does **not** run server functions, so use one of these:

**Option A: GitHub (recommended, auto-deploys on every change)**
1. Put this folder in a new private GitHub repo.
2. Netlify → **Add new site → Import an existing project → GitHub** → pick the repo.
   The build settings come from `netlify.toml`; leave them as they are.

**Option B: Netlify CLI from your computer**
```bash
npm install
npx netlify-cli login
npx netlify-cli deploy --prod     # choose "Create & configure a new site" the first time
```

Then, in Netlify → **Site configuration → Environment variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1.5 |
| `SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key (mark it **Secret**) |
| `ALLOWED_EMAIL_DOMAINS` | optional, e.g. `oceanicpharmachem.com` (comma-separated). Blocks any other email. |
| `ALLOWED_EMAILS` | optional, specific extra emails allowed (comma-separated) |
| `ENFORCE_INDEPENDENT_REVIEW` | `false` while testing, then **`true`** so nobody can sign or approve their own work |

Choose **Deploys → Trigger deploy** so the function picks up the variables.

### 3. Connect the two

In Supabase → **Authentication → URL Configuration**, set **Site URL** to your Netlify address
(e.g. `https://oceanic-eln.netlify.app`). This is needed for the "email me a sign-in link" option.

Open the Netlify URL and sign in. Done.

---

## Where the data is

- **Records**: Supabase → **Table Editor** → `entries`, `requests`, `samples`. The columns `id`, `summary`,
  `status`, `updated_by` and `updated_at` are readable at a glance; `doc` holds the full record. Export to CSV from there.
- **Audit trail**: `audit_log`, one row per save with who, when, what action, and a full copy of the record.
  The database refuses any edit or delete on this table.
- **Files**: Supabase → **Storage → lab-files**:
  - `LAB-Working/Chemistry/<year>/<project>/<entry>/`: reaction scheme images
  - `LAB-Working/Analytical/<year>/Characterization/<ANA id>/Raw_data/`: instrument PDFs
  - `LAB-Records/Chemistry/<year>/CHEM-….pdf`: signed ELN entry PDFs
  - `LAB-Records/Analytical/<year>/`: sample sheet PDFs and copies of the instrument reports

Do not edit the `doc` column or `version` by hand. Change records through the app.

## Costs

- **Netlify**: the free plan is enough for a small lab.
- **Supabase**: the free plan works for a pilot, but **free projects pause after 7 days without use and have no
  backups**. For real lab records use **Pro (US$25/month)**, which adds daily backups and doesn't pause.

## Testing without Supabase

```bash
npm install
npm test               # runs the whole workflow (entry → sign → request → results → approve → report) on an in-memory database
npm run dev:mock       # the full app on http://localhost:8899 with an in-memory database; sign in with any email and password "pw"
```

## Notes and limits

- **This is still an R&D tracking tool, not a validated ELN/LIMS.** For GMP or regulatory work (21 CFR Part 11,
  EU Annex 11) you would also need system validation, e-signatures that re-ask for the password at signing,
  password policies, and SOPs. The audit log and record locks are a good base for that.
- Signed links to files expire after 10 minutes. Opening a file from the app always gets a fresh link.
- Uploads go straight from the browser to storage, through a one-time slot that the server checks first.
  The server only accepts PNG and JPEG for reaction schemes, PDF for reports, and files up to 20 MB.
- The page loads the Supabase sign-in library from the jsDelivr CDN and fonts from Google Fonts.

## Files

```
public/index.html                 the app (the doctor's page plus sign-in, the /api bridge, and storage links)
netlify/functions/api.mjs         the one server endpoint: checks the user and calls lib/core.mjs
lib/core.mjs                      all workflow rules (port of Code.gs)
lib/pdf.mjs                       signed-entry and sample-sheet PDFs
lib/supabase-adapters.mjs         talks to Supabase Postgres and Storage
supabase/schema.sql               run once in Supabase
netlify.toml                      Netlify build settings
test/                             automated tests and a local mock server
```
