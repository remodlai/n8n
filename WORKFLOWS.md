# GitHub Workflows Documentation

## Action Pinning Requirements

Most GitHub Actions should be pinned to a full 40-character SHA to ensure immutability and security.

```yaml
# Good - Pinned to full SHA
- uses: actions/checkout@a12a3456b78912345c6d78912345d6e7f8901234

# Bad - Pinned to version tag (mutable)
- uses: actions/checkout@v3
```

### Exceptions

1. **Local Actions**: Actions in the same repository (using `./` prefix) do not need SHA pinning.
   ```yaml
   - uses: ./.github/actions/setup-and-build
   ```

2. **Reusable Workflows**: References to reusable workflows, especially SLSA generators, MUST use version tags instead of SHA pinning per SLSA verification requirements.
   ```yaml
   # Correct usage for reusable workflows
   - uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.1.0
   ```