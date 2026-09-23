# Contributing to Project Cutout

Pull requests are welcome. This file is the whole process.

## Proposing protocol changes

The spec is the product: `SPEC.md` defines what every implementation
must agree on. For anything that changes the contract — new message
types, endpoint behavior, field semantics, limits — **open an issue
before a PR**. A small change to one sentence of the spec can break
every client, so behavior changes get discussed first and coded second.
Bug fixes, docs, examples, and client improvements can go straight to
a PR.

## The PR bar

- Tests pass: `python3 tests/smoke_test.py` (add a test when you change
  server behavior).
- Dependency-free stays dependency-free: the reference server and the
  Python client are standard-library only, the Node client has zero
  dependencies. New dependencies need a very good reason, raised in an
  issue first.
- Wire compatibility: the reference server and the Supabase edge
  function in `supabase/` must stay interchangeable. Change one,
  change the other, and say so in the PR.
- Clarity over cleverness, in code and in docs.

## House conventions

- **No names anywhere.** The license line is "the Cutout contributors"
  and that stays the only attribution in the repo — no personal or
  company names in code, docs, commit messages, or examples.
- **No secrets, ever.** No tokens, real bus URLs, email addresses, or
  phone numbers in anything committed. Examples use `example.com` and
  placeholder hosts.
- Everything you contribute is under the MIT license.

## Reporting problems

Ordinary bugs: open an issue with the request, the response, and what
you expected. Never include a live token or a real bus URL in an
issue — rotate the token first, then redact.
