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
shown under App registrations).

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

1. New registration, single tenant, platform **Web**, redirect URIs:
   - `https://pokemonkarten.at/admin/auth/callback`
   - `https://staging.pokemonkarten.at/admin/auth/callback`
   - `http://localhost:3000/admin/auth/callback` (development)
2. Certificates & secrets → new client secret → `ENTRA_CLIENT_SECRET` (note the expiry date).
3. API permissions: Microsoft Graph delegated `openid`, `profile`, `email` (default, no admin
   consent needed).
4. Who may sign in – one of:
   - **Groups:** create security groups "Shop-Admins" and "Shop-Staff"; Token configuration →
     add groups claim → Security groups (ID token). Put the group object IDs into
     `ENTRA_OWNER_GROUP_ID` and `ENTRA_STAFF_GROUP_ID`.
   - **App roles:** create the roles `Shop.Owner` and `Shop.Staff` and assign users under
     Enterprise applications → Users and groups.
5. Enterprise applications → pokemonkarten-admin → Properties → _Assignment required_ = Yes, then
   assign the people (or groups) who may use the admin.

MFA follows your tenant's Conditional Access policies.
