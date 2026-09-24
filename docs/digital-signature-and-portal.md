# Digital signature and client portal access

Status: **required, immediate** — raised 2026-09-24 by the estimating
lead. Not built. Paper signatures remain the process until it is.

## Why this exists

Expo takes paper signatures today, and ForgeOS records them: an internal
user types the client's name and title into the proposal page and the
system marks the deal Won and opens a Project.

That recording step has been triggered by mistake twice on one estimate
in two days, by someone who had just locked a version and was looking for
the next step. Both times the correction needed a hand-written database
script. The interface has since been made harder to trip over and the
undo is now a button (`unwindProposalSignature`), but the underlying
shape is still wrong: **the person who prepares a proposal should never be
the person who can mark it accepted.**

## The flow this replaces it with

1. Internally, a proposal is approved as ready — a separate step from
   anything the client does, and the only step an estimator takes.
2. The sales rep sends it to the client.
3. The client reviews it and approves it for signature.
4. ForgeOS emails them a signing link.
5. They sign digitally.
6. Signing also enrols them in their client portal — one action, so
   portal access is a consequence of signing rather than a separate
   invitation somebody has to remember to send.

Only step 5 marks the deal Won and creates a Project, and only the client
can take it.

## What that removes

- An internal user recording an acceptance that has not happened.
- The gap between a deal closing and the client having portal access.
- The paper copy as the only record of what was agreed.

## Dependencies worth knowing before starting

- **Email delivery is currently broken.** Resend is sending from an
  unverified domain, which already blocks client artwork-portal invites.
  A signing link is useless until that is fixed, and it is the first
  thing to do.
- Client portal auth already exists for artwork
  (`artwork-portal-auth.ts`) and is the pattern to follow rather than a
  second, parallel one.
- `ProposalStatus` has no state between SENT and SIGNED for "the client
  approved it for signature". That is the one schema change this needs.

## Until then

Paper is fine. The sign block on the internal proposal page now states
whose signature it records and what it does, sits behind a confirm, and
can be undone from the page rather than from a database console.
