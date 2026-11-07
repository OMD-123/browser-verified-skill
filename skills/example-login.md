---
name: example-login
description: An example skill showing how to write one. Copy it and edit it for a site you know.
version: 1.0.0
origin: example.test
untrusted: false
allowedActions:
  - click
  - fill
---

# Signing in to example.test

The login page is at `/login`. The form has no visible labels, so the
locator is by role and placeholder.

1. Go to `/login`.
2. Fill the username field: `bv act fill 'role=textbox name="Username"' 'USERNAME'`.
3. Fill the password field: `bv act fill 'role=textbox name="Password"' '{{secret:example_password}}'`.
4. Click the button: `bv act click 'role=button name="Sign in"'`.

**The click needs an approval.** It is a `submit`, so the action is
refused with an approval id. Show the id to the user, get the token with
`bv approve <id>`, and run the action again with `--approve <token>`.

The password comes from the vault, not from this file. A skill never
contains a secret.

## After signing in

The dashboard takes a few seconds to load. Wait for the text `Dashboard`
before doing anything else:

```bash
bv verify --condition condition.json
```

If the verification fails, take a snapshot and look at what is actually
on the page rather than retrying the click.
