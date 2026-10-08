# AGENTS.md

This repo is a pi extension that shows a live tokens-per-second meter. It is published to npm as [`@duncanbeard/pi-tps-meter`](https://www.npmjs.com/package/@duncanbeard/pi-tps-meter), and the source lives at [`DuncanBeard/pi-tps-meter`](https://github.com/DuncanBeard/pi-tps-meter).

## Layout

- `extensions/tps-meter.ts` is the entire extension. Pi loads TypeScript directly through jiti, so there is no build step.
- `package.json` is the npm and pi manifest.
- `README.md` holds the user docs, which appear on npm and the pi.dev gallery. Update it whenever commands or behavior change.
- `AGENTS.md` is this file. It is not published, because the `files` list in `package.json` leaves it out.

## Git identity (required)

- Commit and push **only** as the personal GitHub account `DuncanBeard`. Never use `duncanbeard_microsoft`, and never use an `@microsoft.com` email.
- The identity is stored in this repo's local config. The global git config has no identity; leave it that way. On a fresh clone, set it again:
  ```bash
  git config user.name "Duncan Beard"
  git config user.email "5641626+DuncanBeard@users.noreply.github.com"
  ```
  Before every commit, `git config user.email` must print the noreply address above.
- Git Credential Manager stores both GitHub accounts. The remote URL includes `DuncanBeard@` so that GCM always picks the personal one. Keep it that way:
  ```bash
  git remote set-url origin https://DuncanBeard@github.com/DuncanBeard/pi-tps-meter.git
  ```
- After pushing, check that GitHub credits the commit to `DuncanBeard`. Both lines should show it:
  ```bash
  curl -s https://api.github.com/repos/DuncanBeard/pi-tps-meter/commits/main | grep -m2 '"login"'
  ```

## Package rules

- Keep `pi-package` in `keywords`. The pi.dev gallery lists packages based on that keyword.
- Packages that pi provides (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) belong in `peerDependencies` with the range `"*"`. Never put them in `dependencies`. Any other runtime import goes in `dependencies`.
- `files` lists exactly what gets published: `extensions/`, `README.md`, `LICENSE`. After adding files, run `npm pack --dry-run` to check the result.

## Test

Load check, which doesn't call a model. Don't use `pi --help` for this, because it doesn't report extension load errors.

```bash
{ printf '{"id":"1","type":"get_commands"}\n'; sleep 8; } \
  | pi --mode rpc --no-session -ne -ns -np --offline -e . 2>/tmp/rpc.err \
  | grep -m1 '"command":"get_commands"' | grep -q '"name":"tps"' \
  && echo "OK: /tps registered" || cat /tmp/rpc.err
```

`-ne` stops every other extension from loading, including an installed copy of this package, so `/tps` is not registered twice. To check by hand, run `pi -ne -e .`, send a prompt, watch the meter, and try `/tps`, `/tps off`, `/tps on` and `/tps clear`.

## Release

1. Commit your changes using the identity above. The working tree must be clean.
2. Bump the version. This commits and tags `vX.Y.Z` using this repo's identity.
   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```
3. Publish. `npm whoami` must print `duncanbeard`. If it doesn't, log in. In an agent shell, run the login in the background and give the user the `Login at:` URL from the log:
   ```bash
   setsid nohup npm login --auth-type=web > /tmp/npm-login.log 2>&1 < /dev/null &
   ```
   The npm account has 2FA turned on. In a real terminal, `npm publish` prints a link to approve in the browser. In an agent shell there is no terminal, so a plain `npm publish` fails with `EOTP`. Run it in a pseudo-terminal in the background and give the user the approval link:
   ```bash
   setsid nohup bash -c 'exec 3< <(sleep 900); script -qfec "npm publish" /dev/null <&3; kill $! 2>/dev/null' \
     > /tmp/npm-publish.log 2>&1 < /dev/null &
   sleep 15; grep -a -A1 "Authenticate your account" /tmp/npm-publish.log
   ```
   Once the user approves, `+ @duncanbeard/pi-tps-meter@X.Y.Z` appears in the log and the wrapper exits by itself. Another option is to ask the user for a current 6-digit code and immediately run `npm publish --otp=<code>`.
4. Confirm the release. A new version can take a few minutes to show up.
   ```bash
   npm view @duncanbeard/pi-tps-meter version
   ```
   For a full check, rerun the load check with `-e npm:@duncanbeard/pi-tps-meter` in place of `-e .`, and drop `--offline` so pi can download the package.

Changes that only touch `AGENTS.md` don't need a release, because the file isn't published.

## Using it in pi on this machine

- If `~/.pi/agent/extensions/tps-meter.ts` exists, it is the copy from before the package was published. Remove it before you install the package; otherwise `/tps` loads twice:
  ```bash
  rm ~/.pi/agent/extensions/tps-meter.ts
  pi install npm:@duncanbeard/pi-tps-meter
  ```
- After each release, update the installed copy with `pi update npm:@duncanbeard/pi-tps-meter`.
- To try unreleased changes for one session, run `pi -ne -e ~/src/pi-tps-meter`.
