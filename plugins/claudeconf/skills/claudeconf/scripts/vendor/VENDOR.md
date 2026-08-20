# Vendored dependency: js-yaml

This directory contains one vendored file, `js-yaml.mjs`, plus this
provenance record. It exists because `skills/claudeconf/scripts/claudeconf-check.mjs`
ships inside the claudeconf plugin and must parse YAML (lefthook configs,
GitHub workflow files) in arbitrary user repos, without depending on the
user having any npm packages installed. Vendoring a single ESM file avoids
a runtime dependency while keeping the source auditable and pinned.

## Package

- **Name:** js-yaml
- **Version:** 5.3.0
- **Registry tarball:** https://registry.npmjs.org/js-yaml/-/js-yaml-5.3.0.tgz
- **Path inside tarball:** `package/dist/js-yaml.mjs`
- **Vendored as:** `skills/claudeconf/scripts/vendor/js-yaml.mjs` (byte-for-byte
  copy of the tarball file — not reformatted, minified, or edited)

## Integrity

- **sha256 of the vendored file:**
  `7c5405f6b6e1aacfcd488520ec06c776ad738cc96001ebae4b6b3a636da0d3fb`

  Computed with:

  ```
  shasum -a 256 skills/claudeconf/scripts/vendor/js-yaml.mjs
  ```

  This must match the sha256 of `package/dist/js-yaml.mjs` extracted directly
  from the `js-yaml-5.3.0.tgz` tarball fetched from the URL above.

## License

MIT. Copyright (C) 2011-2015 by Vitaly Puzrin. Full text of the package's
`LICENSE` file, reproduced verbatim:

```
(The MIT License)

Copyright (C) 2011-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Refresh procedure

To update the vendored copy to a newer js-yaml release:

1. Confirm the target version:
   ```
   npm view js-yaml version
   ```
2. Fetch and extract the tarball:
   ```
   npm pack js-yaml@<ver> --pack-destination /tmp
   tar xzf /tmp/js-yaml-<ver>.tgz -C /tmp
   ```
3. Copy the ESM build into place and record its hash:
   ```
   cp /tmp/package/dist/js-yaml.mjs skills/claudeconf/scripts/vendor/js-yaml.mjs
   shasum -a 256 skills/claudeconf/scripts/vendor/js-yaml.mjs
   ```
4. Update the version, tarball URL, and sha256 in this file. Re-check the
   `LICENSE` text in the new tarball for changes and update the block above
   if it differs.
5. Re-run the smoke test:
   ```
   node -e "import('./skills/claudeconf/scripts/vendor/js-yaml.mjs').then(m=>console.log(typeof m.load))"
   ```
   should print `function`.
