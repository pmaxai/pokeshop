# Microsoft 365 setup

Two app registrations in Microsoft Entra ID: one for sending mail through Microsoft Graph, one
for the admin sign-in. Keep them separate so the mail credential can never be used to sign in
and the sign-in app cannot send mail.

## A. Sending mail as bestellung@pokemonkarten.at

### 1. Mailbox

Create the shared mailbox `bestellung@pokemonkarten.at` (display name "pokemonkarten.at").

### 2. App registration "pokemonkarten-mail"

1. Entra admin center → App registrations → New registration, single tenant, no redirect URI.
2. Certificates & secrets → Certificates → upload the public certificate:

   ```sh
   openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
     -subj "/CN=pokemonkarten-mail" -keyout graph-key.pem -out graph-cert.crt
   cat graph-key.pem graph-cert.crt > graph-cert.pem   # goes to the server, never into git
   ```

3. **Do not** add the Graph application permission `Mail.Send` under "API permissions".
   An Entra grant applies to every mailbox in the tenant; the access is given in Exchange instead,
   limited to the one mailbox (next step). This replaces Application Access Policies, which
   Microsoft no longer recommends.

### 3. Limit the app to the one mailbox (Exchange Online PowerShell)

Use the _Application (client) ID_ and the _Object ID from Enterprise applications_ (not the one
shown under App registrations). There is no admin-center page for this. Azure Cloud Shell needs an
Azure subscription, so run it on your own computer instead: Windows PowerShell has everything but
the module (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`,
`Install-Module ExchangeOnlineManagement -Scope CurrentUser`); on macOS install PowerShell first
(`brew install powershell`, then `pwsh`).

```powershell
Connect-ExchangeOnline

New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "pokemonkarten-mail"

New-ManagementScope -Name "pokeshop-mailbox" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'bestellung@pokemonkarten.at'"

New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" `
  -CustomResourceScope "pokeshop-mailbox"

# Check: InScope must be True for the shop mailbox and False for any other mailbox
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource bestellung@pokemonkarten.at
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource someone.else@pokemonkarten.at
```

Changes can take up to two hours to apply because Exchange caches app permissions.

### 4. DNS for deliverability

- SPF on pokemonkarten.at includes `include:spf.protection.outlook.com`.
- DKIM enabled for pokemonkarten.at in Microsoft Defender (two CNAME records).
- DMARC, e.g. `_dmarc.pokemonkarten.at TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@pokemonkarten.at"`.

### 5. Values for the env file

`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_CERT_PATH` (PEM with key and certificate),
`GRAPH_SENDER=bestellung@pokemonkarten.at`.

## B. Admin sign-in "pokemonkarten-admin"

1. New registration, single tenant, platform **Web** (not "Single-page application"), redirect
   URIs:
   - `https://pokemonkarten.at/admin/auth/callback`
   - `https://staging.pokemonkarten.at/admin/auth/callback`
   - `http://localhost:3000/admin/auth/callback` (development)
2. Certificates & secrets → new client secret. Copy the **Value** column right away; it is shown
   only once. The **Secret ID** column (a GUID) is not the secret. Note the expiry date.
3. Env file: `ENTRA_TENANT_ID` = _Directory (tenant) ID_, `ENTRA_CLIENT_ID` = _Application
   (client) ID_ (both GUIDs from the app's Overview page), `ENTRA_CLIENT_SECRET` = the value.
4. API permissions: Microsoft Graph delegated `openid`, `profile`, `email` (default, no admin
   consent needed).
5. Who may sign in – one of:
   - **App roles (works with every Entra plan):** App registrations → pokemonkarten-admin →
     App roles → create `Shop.Owner` and `Shop.Staff` (allowed member types: Users/Groups; the
     _Value_ must be exactly these strings). Then Enterprise applications → pokemonkarten-admin →
     Users and groups → add each **user** with a role. Assigning groups there needs Entra ID P1.
   - **Groups:** create security groups "Shop-Admins" and "Shop-Staff"; Token configuration →
     add groups claim → Security groups (ID token). Put the group object IDs into
     `ENTRA_OWNER_GROUP_ID` and `ENTRA_STAFF_GROUP_ID`.
6. Enterprise applications → pokemonkarten-admin → Properties → _Assignment required_ = Yes, then
   assign the people who may use the admin.

MFA follows your tenant's Conditional Access policies.

### When the sign-in fails

The login page names the problem; Microsoft's error code (AADSTS…) and a hint are in the web
container's log:

```sh
infra/stack.sh staging logs web | grep '\[entra\]'
```

| Code                         | Cause                                                               | Fix                                                                                |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| AADSTS7000215                | `ENTRA_CLIENT_SECRET` is not the secret value (often the Secret ID) | Copy the **Value** of the client secret; create a new one if it is no longer shown |
| AADSTS7000222                | Client secret expired                                               | New client secret                                                                  |
| AADSTS9002327, AADSTS700025  | Redirect URI registered as single-page app or public client         | Register it under platform **Web**                                                 |
| AADSTS50011                  | Redirect URI not registered                                         | Add the exact URI from step 1                                                      |
| AADSTS700016, AADSTS90002    | Wrong client ID or tenant ID                                        | Copy both GUIDs from the app's Overview page                                       |
| AADSTS50105                  | Account not assigned to the app                                     | Step 6                                                                             |
| (no code) "keine Shop-Rolle" | Signed in, but without `Shop.Owner` / `Shop.Staff`                  | Step 5, then sign in again                                                         |

After changing the env file, run `infra/stack.sh staging up -d` so the container picks it up.
