# ADR 0003 — The honest User-Agent, and the tension it creates

**Status:** accepted (P1) · **Claims:** B9, B13, A14, E1.2 · **Owner sign-off: OPEN**

## Decision

```
blue-ridge-deal-finder/1.0 (+https://github.com/mcorbett51090/blue-ridge-deal-finder; matt@ravenpower.net)
```

One constant, in `pipeline/fetch/guard.ts`. Never a browser UA. Never a string
containing `bot`, `AI`, `Claude` or `GPT`. `assertHonestUserAgent` refuses any
source whose `user_agent` is not byte-identical to it, and
`scripts/verify-sources.mjs` refuses the registry.

## ⚠️ The tension, stated rather than buried

`georgiapublicnotice.com` and `publicnoticevirginia.com` allow `User-agent: *`
but disallow **ClaudeBot, Claude-Web, anthropic-ai, GPTBot, PerplexityBot and
Scrapy by name** (B9, B13). Our scope requires an *identifying* UA. So the UA we
must send is one those operators have not named, on sites whose operators have
demonstrably thought about who they are excluding.

**The ruling:** this crawler is a personal tool with a contact address, fetching
public notices at ≤0.2 rps for one person's use. The named blocks target
training-corpus collection. `Content-Signal: use=reference` on the sibling
qPublic file (A14) shows these operators distinguish the two cases explicitly.

**This is a judgment call about the spirit of a directive, not a technical
fact.** It is recorded here rather than argued in a commit message so it can be
overturned in one place. Both `robots.txt` files should be quoted verbatim into
this file at P4, when those sources are first fetched.

E1.2 independently establishes that spoofing a browser UA **would not have
worked anyway** — the qPublic wall is not UA-based — so the honest UA costs
nothing that dishonesty would have bought.

## Consequences

- A contact address is published, which means someone can complain. That is the
  point: `sources/PAUSE` is a tracked file, and one commit stops everything.
- `/about/` must name the crawler, its UA, its rate, its purpose and the contact
  address before any third-party notice source is fetched (P4).
- **Owner sign-off is still owed** on the GA/VA named-block reading.
