# Dependency advisory review

Checked on 2026-11-11 with npm 12.0.2 against the project's dependency specification and the lockfile fingerprint below. Advisory results are a dated snapshot and should be checked again when dependencies change.

## Results

- `npm audit --omit=dev --json`: **0 vulnerabilities**, exit status 0.
- `npm audit --json`: **16 affected dependency entries** (13 high, 3 moderate), exit status 1.
- The full report traces to three underlying advisories in development tooling. Counts include dependent packages that inherit an advisory, not 16 distinct flaws.

The affected packages belong to the Hardhat/Mocha toolchain. They execute on developer or CI machines and are not included in the deployed Solidity bytecode. The production-only npm result covers the installed dependency graph; it does not establish smart-contract security. The token-side analysis is in the separate [reentrancy review](reentrancy-review.md).

## Open advisories

| Package in lockfile | Advisory | Reported issue | Patched version | Compatibility constraint |
| --- | --- | --- | --- | --- |
| `zod@3.25.76` | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | High: excessive memory use while validating large collections. | `4.6.6` | Hardhat `3.21.2` and several plugins require `^3.23.8`; the patched version is outside that range. |
| `glob@13.0.7` | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | Moderate: an aborted traversal may continue filesystem work. | `14.0.2` | Mocha `12.0.3` requires `^13.0.0`; the patched version is outside that range. |
| `minimatch@10.2.6` | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Moderate: crafted glob patterns can amplify CPU and memory usage. | `11.0.1` | Mocha `12.0.3` and the locked glob release require `^10.2.2`; the patched version is outside that range. |

The registry's current `latest` releases checked for Hardhat and Mocha are `3.21.2` and `12.0.3`, respectively, matching this project's pins. A dependency update within their declared ranges cannot reach the patched versions listed above. npm suggests major toolchain downgrades for several findings; these are not drop-in fixes for the configured Hardhat 3 and Mocha 12 plugins.

These findings remain unresolved. Use the toolchain with trusted project configuration, test files, and local input. Any remediation must be checked against the supported plugin dependencies and pass a clean installation, compilation, full tests, and TypeScript checks. Do not use forced upgrades, major-version overrides, or audit suppression merely to make the report pass.

## Reproduce

```sh
npm ci
npm audit --json
npm audit --omit=dev --json
npm view hardhat@latest version dependencies.zod --json
npm view mocha@latest version dependencies.glob dependencies.minimatch --json
```

`npm audit` returns a nonzero status while these findings are present. Package installation and passing tests do not resolve an advisory.

Lockfile SHA-256:

```text
d9cb29a3bb3a7ee168ca52f2650e8ac7b47024f74bdc8c1206a01e475138efd6  package-lock.json
```
