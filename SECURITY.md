# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately to `support@orbb.app`.
Include the affected extension version, reproduction steps, and potential
impact. Do not include real access tokens, private saved content, or social
cookies in a public issue.

We will acknowledge a report, investigate it, and coordinate a fix before
public disclosure when appropriate.

## Security model

- Orbb access is granted through an explicit QR approval and a scoped,
  expiring bearer token.
- The token remains in the background service worker's trusted Chrome storage
  context and is redacted from UI snapshots.
- Social-provider passwords and cookies are not copied into extension storage.
- Provider access is optional and requested separately for each provider.
- The manifest `key` is a public identity key, not a private signing key.
  Server authorization must rely on user-approved credentials, scopes,
  revocation, and rate limits—not on extension origin alone.
