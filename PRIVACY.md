# Privacy policy

Orbb for Chrome helps a user save content to their own Orbb account. It does
not sell personal information or use captured content for advertising.

## Data handled by the extension

The extension may handle:

- the URL, title, selected text, or file that the user chooses to save;
- saved-post URLs, captions, folder names, and preview images collected from
  Instagram, Reddit, or X when the user enables that provider;
- an Orbb bearer token, its expiry, and basic Orbb profile information;
- recent extension activity and normalized URLs used for duplicate detection;
- provider permissions and automatic-import settings.

The extension does not ask for or store Instagram, Reddit, or X passwords.
Social collection runs inside a provider page that is already signed in within
Chrome. Provider cookies and CSRF values are used only inside that page to make
same-provider requests and are not returned to the extension or sent to Orbb.

## When data is transmitted

Content is sent to `https://api.orbb.app` only after the user saves it, confirms
a manual import, or enables scheduled collection. QR authentication exchanges
a one-time session with the same service. No analytics or advertising service
receives extension activity.

## Local storage and retention

Chrome local storage holds the Orbb token until it expires or the user
disconnects, plus at most 40 recent activity entries and 5,000 normalized URLs
for duplicate detection. If token revocation is interrupted, the credential is
retained only until revocation succeeds or it expires. Chrome storage access is
restricted to trusted extension contexts.

Disconnecting removes the active credential from the extension and attempts to
revoke it at Orbb. Clearing recent activity removes the local activity list.
Deleting the extension removes its Chrome-managed local storage.

## Browser permissions

- `activeTab` and `tabs`: identify the current page and open temporary,
  inactive provider tabs for an import.
- `scripting`: collect the saved items visible to the signed-in provider page.
- `storage`: retain the Orbb session, settings, duplicate index, and activity.
- `alarms`: run collection only at the schedule selected by the user.
- `contextMenus` and `sidePanel`: expose the extension's capture interface.
- `https://api.orbb.app/*`: authenticate and save privately to Orbb.
- Instagram, Reddit, and X hosts are optional and requested only when the user
  enables or starts an import for that provider.

## Contact

Privacy questions can be sent to `support@nextra.app`.
