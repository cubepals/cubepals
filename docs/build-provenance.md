# Build provenance

Each nightly release's source archive carries a signed attestation: GitHub's record that the file was
built by the Nightly workflow (`.github/workflows/nightly.yml`) from this repository at the commit
the release names. The archive is attached to the release as `cubepals-<tag>.tar.gz`.

## Check one

Download the archive from the release, then:

```sh
gh attestation verify cubepals-v1.2.3-nightly.20261022.7.tar.gz --repo cubepals/cubepals
```

It passes only if the file's digest matches a signed attestation made by a workflow run in
`cubepals/cubepals`. Add `--signer-workflow cubepals/cubepals/.github/workflows/nightly.yml` to
require that run to be the Nightly, and `--format json` to read the commit and run it names.

## What is attested, and what is not

- **Attested:** the nightly release's archive, through `actions/attest-build-provenance`. The job
  holds `id-token: write` (to sign) and `attestations: write` (to store), and nothing else beyond
  what it already had.
- **Not yet:** images. CI builds the control plane and edge images to start them and throws them
  away, and deploys build on Fly's builders, which do not run in GitHub Actions. Once an image is
  pushed from a workflow, its job adds the same step with `subject-name`, `subject-digest` and
  `push-to-registry: true`, and `gh attestation verify oci://<image>@<digest>` checks it.
- **Not yet:** the production releases `scripts/production.ts` makes from the operator's machine.
