# Security

Please don't open a public issue for a security problem.

## Reporting

Report it privately on GitHub: **[Report a vulnerability](https://github.com/cubepals/cubepals/security/advisories/new)**.
Say what is affected, how to reproduce it, and what someone could do with it. You will hear back,
and you'll be told when it is fixed and whether you want to be credited.

## Scope

- This repository: the control plane, the web app, the edge and the infrastructure code.
- `blocklyd`, the node daemon: report it in
  [cubepals/blocklyd](https://github.com/cubepals/blocklyd/security/advisories/new).
- The hosted service at `cubepals.com`, `rt.cubepals.com` and `*.play.cubepals.com`.

Only `main` and what runs on cubepals.com are supported; there are no older release lines.

## Testing against the hosted service

Use your own account and your own servers. Don't touch other people's servers, worlds or data,
don't run denial-of-service or load tests, and don't use automated scanners that flood the
service. Stop and report as soon as you find a problem, and don't keep any data you saw. Research
done that way, in good faith, will not be pursued.
