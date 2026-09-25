# Container image signing and verification

The backend and frontend images are built and pushed by
`.github/workflows/container-signing.yml`. Each image is signed with keyless
Cosign using the GitHub Actions OIDC identity, and its SPDX SBOM is attached as
an in-registry attestation. The workflow also uploads the SBOM and verification
output as release artifacts.

Blue-green deployment verifies the backend image with Cosign before App Runner
is updated. Unsigned images, images signed by another workflow, and tampered
digests are rejected before deployment. Keep the AWS ECR Public repository
permissions and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` secrets restricted
to the release environment.

For a local verification, install Cosign and run:

```sh
cosign verify public.ecr.aws/remitmortgage/backend:<sha> \
  --certificate-identity "https://github.com/AstronLabs/remitMortage/.github/workflows/container-signing.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```
