# Security Policy

We take the security of this project seriously. If you discover any security vulnerabilities or have concerns regarding the security of this repository, please reach out to us immediately. We appreciate your efforts in responsibly disclosing the issue and will make every effort to address it promptly.

SillyBunny is a local-first SillyTavern fork that handles user chats, character cards, presets, extension files, API keys, cookies, and optional remote provider requests. Treat privacy, local file access, and secret handling as security-sensitive even when a bug is not remote-code-execution severity.

## Reporting a Vulnerability

To report a security vulnerability, please follow these steps:

1. Go to the **Security** tab of this repository on GitHub.
2. Click on **"Report a vulnerability"**.
3. Provide a clear description of the vulnerability and its potential impact. Be as detailed as possible.
4. If applicable, include steps or a PoC (Proof of Concept) to reproduce the vulnerability.
5. Submit the report.

Once we receive the private report notification, we will promptly investigate and assess the reported vulnerability.

Please do not disclose any potential vulnerabilities in public repositories, issue trackers, or forums until we have had a chance to review and address the issue.

## Scope

This security policy applies to all code and files within this repository, including launcher/update flows, server routes, browser-side code, bundled defaults, bundled extensions, companion and in-chat agent workflows, Docker/runtime helpers, and dependencies actively maintained by us. If you encounter a security issue in a dependency that is not directly maintained by us, please follow responsible disclosure practices and report it to the respective project.

Examples of in-scope issues include, but are not limited to:

- Exposure or mishandling of API keys, cookies, session data, character data, chats, lorebooks, presets, or extension secrets.
- Cross-site scripting, prompt/output HTML injection that escapes existing sanitization expectations, CSRF bypasses, unsafe CORS behavior, or host/trusted-proxy validation bypasses.
- Path traversal, arbitrary file read/write/delete, unsafe ZIP extraction or update behavior, and launcher or dependency-install paths that can execute untrusted code unexpectedly.
- Remote request filtering bypasses, SSRF-style provider requests, unsafe proxy handling, or model/provider integrations that leak private local data.
- Security regressions in Bun or Node.js parity paths, Docker startup, Termux launchers, or updater flows.

While we strive to ensure the security of this project, please note that there may be limitations on resources, response times, and mitigations.

## Agent Guidance

Agents working on security-sensitive code should preserve existing validation, sanitization, CSRF, host-validation, rate-limit, secret-storage, and private-request-filtering behavior unless the task explicitly changes it. Prefer compatibility-preserving hardening over schema churn, avoid logging secrets or prompt payloads by default, and verify both Bun and Node.js paths when touching backend request, update, or filesystem behavior.

Thank you for your help in making this project more secure.
