# Security

Maestro is an experimental, single-owner voice remote. Coding agents can
read, edit, and run files under their usual permissions. Choose a project
folder you trust and retain each provider's approval controls.

The setup page binds to localhost on port 4210. Do not expose this port or
Herdr through a tunnel. Devices use authenticated HTTPS on port 4211. Remote
access forwards to the separate device listener on port 4212; setup routes
are absent there. Dot uses its own scoped OAuth grant and signed callbacks.

Local runtime data lives in `.local` for source installs or
`~/Library/Application Support/Maestro` for the app. It contains credentials,
conversation history, certificates, and recovery images. Keep it private and
exclude it from public support logs. Local speech runs on the Mac; the agent
you select receives the transcript and handles it under its own terms.

The StopWatch stores its Wi-Fi settings, device key, and optional Muse token
in flash. Flash encryption and secure boot are off so USB recovery remains
available. Someone with physical access can extract those credentials. Treat
the device and recovery images as sensitive. After losing or transferring a
device, revoke its Muse pairing/token, replace `deviceToken` in the private
Mac configuration with a new random value, restart Maestro, and provision
any replacement device over USB. Disconnect Dot in setup to revoke its grant.

The local TLS certificate lasts one year. Quit Maestro, move its
`bridge-cert.pem` and `bridge-key.pem` to a private backup, then restart so it
creates a new pair. Save the new connection to the StopWatch over USB. Do not
delete your configuration or recovery images to renew a certificate.

Report a security issue privately through the repository's **Security →
Report a vulnerability** page when enabled. If private reporting is not yet
available, contact the maintainer through the GitHub profile before sharing
details. Do not post credentials or exploit details in a public issue.

CI scans Git history with Gitleaks. Before publishing a source snapshot,
scan the extracted archive too. Removed files can remain in Git history.
