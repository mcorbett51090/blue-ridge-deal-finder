# P0 probe log — blue-ridge-deal-finder

**Run date:** 2026-08-19 · **Operator:** backend-coder · **Host:** Matt's Mac (residential IP)
**User-Agent on every request:**
`blue-ridge-deal-finder/1.0 (+https://github.com/mcorbett51090/blue-ridge-deal-finder; matt@ravenpower.net)`
**Rate limit:** ≤1 req/s per host, `sleep 1` between every request in every batch.

## How to read this log

Every probe ran inside a **positive + negative control block in the same batch**. A probe that
returned an empty or zero result *without a passing positive control in that batch* is recorded as
**FAIL** or **INCONCLUSIVE**, never as a clean absence.

Verdicts: **PASS** (probe worked, question answered) · **FAIL** (source unusable, or probe could not
see) · **INCONCLUSIVE** (a control failed, or the answer is genuinely not yet determinable).

⚠️ Three probes in this log were **initially wrong and corrected by their own controls**. They are
kept in place, with the correction, because the correction is the evidence that the method works:
- §2.4 Buncombe read as "zero inventory" until a date-window control produced 60 records.
- §8.2 a page-overlap count of 1 was a regex artifact (`[0-9]*` matches zero digits).
- §2.4 a "60 events since 2007" figure was a line-folding artifact; the real span starts 2022-01-18.

---

## §0 — Global control block (run first, re-run in every subsequent batch)

| probe | command | HTTP | bytes | verdict |
|---|---|---|---|---|
| positive | `curl -A "$UA" https://example.com/` | **200** | 559 | probe can see success |
| negative | `curl -A "$UA" https://example.com/definitely-not-a-real-path-xyz-20260819` | **404** | 559 | probe can see failure |
| DNS-failure | `curl -A "$UA" https://this-host-does-not-exist-brdf-20260819.invalid/` | — | — | curl **exit 6**, "Could not resolve host" |
| ArcGIS positive | `.../NC1Map_Parcels/MapServer/1/query?where=cntyname='Watauga'&returnCountOnly=true&f=json` | 200 | 15 | `{"count":47388}` — matches E2.7 exactly |
| ArcGIS negative | same, `where=cntyname='Zzzznotacounty'` | 200 | 11 | `{"count":0}` |

**Verdict: PASS.** The probe distinguishes success, HTTP failure, DNS failure, and a real-vs-empty
result set.

⚠️ **Note the trap this control itself exposes:** the positive and negative example.com responses are
**both 559 bytes**. Byte count alone never discriminates. Status and body shape do.

---

## §1 — LandSearch — THE DECIDING PROBE — **FAIL**

Claim under test: **B35** rated LandSearch 🟢 **GREEN**, "best land-listing candidate found", on the
strength of a permissive `robots.txt` and a `Content-Signal: ai-train=yes` header. **B35 never
fetched a listing page.**

### §1.1 robots.txt — reproduced exactly as B35 described

```
curl -A "$UA" https://www.landsearch.com/robots.txt
```
| | HTTP | bytes |
|---|---|---|
| `robots.txt` | **200** | 540 |
| control positive (example.com) | 200 | 559 |
| control negative (bogus LandSearch path) | **403** | 5,739 |

Body, verbatim:
```
User-Agent: *
Allow: /
Content-Signal: ai-train=yes,search=yes,ai-input=yes

Sitemap: https://www.landsearch.com/sitemaps/index.xml
Sitemap: https://www.landsearch.com/sitemaps/listings/index.xml
...7 sitemaps total
```

**B35's robots.txt finding is confirmed true.** ⚠️ But the negative control already disagrees with
it: a bogus path returned **403 / 5,739 B**, not 404. That is a Cloudflare wall shape, not a 404.

### §1.2 Content paths — every one is walled

```
curl -A "$UA" https://www.landsearch.com/sitemaps/index.xml
curl -A "$UA" https://www.landsearch.com/
curl -A "$UA" https://www.landsearch.com/properties/watauga-county-nc
curl -A "$UA" https://www.landsearch.com/properties/fannin-county-ga
curl -A "$UA" https://www.landsearch.com/properties/nelson-county-va
curl -A "$UA" https://landsearch.com/                       # apex
curl -A "$UA" https://www.landsearch.com/robots.txt          # re-confirm in same batch
curl -A "$UA" https://example.com/                           # positive control
```

| target | HTTP | bytes | `<title>` |
|---|---|---|---|
| `/sitemaps/index.xml` (**advertised in its own robots.txt**) | **403** | 5,654 | `Just a moment...` |
| `/` (www) | **403** | 5,579 | `Just a moment...` |
| `/` (apex) | **403** | 5,579 | `Just a moment...` |
| `/properties/watauga-county-nc` | **403** | 5,684 | `Just a moment...` |
| `/properties/fannin-county-ga` | **403** | 5,681 | `Just a moment...` |
| `/properties/nelson-county-va` | **403** | 5,681 | `Just a moment...` |
| `/robots.txt` (same batch) | **200** | 540 | — |
| **control** example.com | **200** | 559 | — |

Response header on the Watauga request:
```
cf-mitigated: challenge
server: cloudflare
server-timing: chlray;desc="a2d99c00bf563f1e"
```

`cf-mitigated: challenge` is Cloudflare stating explicitly that it served an interactive challenge.

### §1.3 Three-way UA control — this is not a UA artifact

Same single URL (`/properties/watauga-county-nc`), three user agents, one batch. **The browser UA is
a diagnostic control only and is never a production path** (see §11).

| UA | HTTP | bytes | title |
|---|---|---|---|
| honest project UA | **403** | 5,684 | `Just a moment...` |
| default curl UA | **403** | 5,471 | `Just a moment...` |
| Chrome 120 macOS UA (diagnostic) | **403** | 5,728 | `Just a moment...` |
| control example.com, honest UA | **200** | 559 | — |

### §1.4 Verdict — **FAIL**

LandSearch serves **`robots.txt` and nothing else** to any non-JS client. It is a hard
Cloudflare managed-challenge wall, identical in shape to the qPublic wall (E1: 403 / 5,799 B) and to
the Akamai/Cloudflare walls that already put Ten-X, LandWatch, LandAndFarm, LandsOfAmerica and
ByOwner.com on the do-not-scrape list for **technical** reasons (B34, B38).

**B35's 🟢 GREEN rating is downgraded to 🔴 RED.** The rating was derived from `robots.txt` alone;
`robots.txt` is the one path the wall exempts, which is precisely why the wall was invisible to a
robots-only probe. A site's stated crawl posture and its enforced crawl posture are different facts
and must be measured separately.

### §1.5 The MLS-derivation question — **INCONCLUSIVE, and moot**

The task asked whether LandSearch inventory is MLS-derived (redundant with Zillow) or genuinely
disjoint (by-owner / off-market). **I could not fetch a single listing, so I cannot answer it, and I
will not infer an answer.** No listing attribution field, no IDX/broker marker, and no by-owner flag
was ever observed by this probe or by B35.

What would settle it: a human opening ~10 LandSearch listings for Watauga/Fannin/Nelson in a browser
and reading the attribution line on each. That is a 15-minute manual task and it is the only path,
because the automated path is closed.

**Why it is moot for the build:** the question was "should we ingest LandSearch?" The answer is no
regardless of which way the MLS question falls, because the source is unreachable. The consequence
the task anticipated has landed anyway: **the on-market lane collapses to distress-only.**

---

## §2 — NC per-county tax foreclosure — does A19 generalise? — **PARTIAL PASS**

Claim under test: **A19**, `haywoodcountync.gov/337/Tax-Foreclosures` is the one confirmed NC county
tax-foreclosure page. Question: does the pattern generalise to other NC target counties?

### §2.1 robots.txt for five NC counties (fetched BEFORE any content path)

| host | HTTP | bytes | `*`-group verdict for our paths | Crawl-delay |
|---|---|---|---|---|
| `www.haywoodcountync.gov` | 200 | 816 | **allow** | none for `*` (Siteimprove: 20) |
| `www.wataugacounty.org` | 200 | 209 | allow | none |
| `www.buncombecounty.org` | 200 | 842 | allow | none |
| `www.buncombenc.gov` | 200 | 842 | allow | none |
| `www.jacksonnc.org` | 200 | 816 | **allow** | none |
| `www.hendersoncountync.gov` | 200 | 3,885 | allow | **15 s — must be honoured** |
| control positive (example.com) | 200 | 559 | — | — |
| control negative (example.com bogus) | 404 | 559 | — | — |

Haywood/Buncombe/Jackson robots.txt bodies are effectively identical → same CMS vendor
(**CivicPlus / CivicEngage**, confirmed by the 404 page title `Custom404 • … • CivicEngage`).
Henderson is Drupal.

Grep control on Haywood robots.txt, proving the "`/Bids.aspx` is not disallowed" claim is a
measurement and not an eyeballing:
```
grep -c -i 'bids'     rb-haywood.body  ->  0    # the path we want is not mentioned
grep -c -i 'disallow' rb-haywood.body  -> 25    # POSITIVE control: the grep does match this file
grep -c -i 'zzqqx'    rb-haywood.body  ->  0    # NEGATIVE control
```
Disallowed paths are `/activedit /admin /common/admin/ /OJA /support /*currentevents* /*search* /*map* /RSS.aspx`.
`/Bids.aspx`, `/DocumentCenter/`, and `/337/Tax-Foreclosures` are **allowed**.

### §2.2 Haywood — A19's page is a PROSE EXPLAINER, not a data feed

```
curl -A "$UA" https://www.haywoodcountync.gov/337/Tax-Foreclosures      -> 200,  98,718 B
curl -A "$UA" https://www.haywoodcountync.gov/999337/No-Such-Page-Xyz   -> 404,  94,819 B  (negative control)
curl -A "$UA" https://example.com/                                      -> 200,     559 B  (positive control)
```
Measured on the page body: **0 `<table>` elements, 0 `.pdf` hrefs, 15 links.** The page text is
statute prose (G.S. 105-374 / 105-375, upset-bid procedure). It carries **no property listings at all.**

⚠️ Again: the 404 negative control is **94,819 B** against the positive's 98,718 B. Byte count
cannot distinguish them; status and content can.

**Where Haywood's actual data lives** — found by extracting the content-region links:
`/Bids.aspx?CatID=17&txtSort=Category&showAllBids=&Status=open`, labelled *"Notice of Tax Foreclosure
Sales"* — the **CivicEngage Bids module, category 17**.

### §2.3 Haywood Bids module — measured inventory

```
curl -A "$UA" '.../Bids.aspx?CatID=17&txtSort=Category&showAllBids=&Status=open'  -> 200, 105,463 B
curl -A "$UA" '.../Bids.aspx?CatID=99917&...'                                     -> 200, 100,402 B  (negative control)
curl -A "$UA" '.../Bids.aspx'                                                     -> 200, 106,253 B  (positive control, all categories)
curl -A "$UA" '.../Bids.aspx?CatID=17&showAllBids=Y&Status='                      -> 200, 172,373 B  (full history)
```

⚠️ **Silent-green trap recorded:** the bogus `CatID=99917` returns **HTTP 200**, not 404. Only the
`<title>` discriminates (`Bid Postings • Tax Foreclosures` vs the generic `Haywood County, NC •
CivicEngage`). A health check keying on status would read a bad category as healthy. Same shape as E7.4.

Extractor control — the first regex I used returned 0 and was **broken**, caught by the all-categories
positive control:

| page | unique `bidID` refs | titles |
|---|---|---|
| CatID=17, open | **3** | all "Tax foreclosure Sale August 20, 2026 at 10:00 a.m." |
| all categories, open (**positive control**) | 4 | the same 3 + `FY27 RFP-REVOLVING LOAN FUND` |
| CatID=17, full history | **122** | all "Notice of Tax Foreclosure Sale — `<date>`" |

The positive control proves the extractor sees rows; the RFP row proves `CatID=17` really filters.

**Measured: 3 open postings today; 122 postings 2019-06 → 2026-08 ≈ 17/yr.**

Detail page `Bids.aspx?bidID=250` (200 / 104,632 B; negative control `bidID=999250` → **404**) carries
structured fields: Bid Title, Category, Status, Publication Date/Time, Closing Date/Time — and the
property itself only as a link to `/DocumentCenter/View/7777/FCDavis`.

⛔ **That PDF is a scanned image with no text layer** (200 / 1,352,410 B):
```
strings hay-doc7777.body | grep -c '/Font'      ->   0     # no text layer
strings hay-doc7777.body | grep -c -i 'Image'   ->   6
strings hay-doc7777.body | grep -c '/Type'      ->   8     # POSITIVE control: strings+grep work
strings hay-doc7777.body | grep -c 'zzqqx'      ->   0     # NEGATIVE control
filters present: 3 × /DCTDecode                           # JPEG-compressed page images
```
**Haywood property addresses/parcels require OCR.** That is a real, unbudgeted cost.

### §2.4 Buncombe — a completely different mechanism, and the richest payload found

Buncombe's sitemap (200 / 127,326 B, 943 `<loc>`) grep, with controls:
```
grep -o -i '<loc>[^<]*foreclos[^<]*</loc>'  ->  https://www.buncombenc.gov/622/Tax-Foreclosure-Sales
grep -c -i 'tax'    -> 9   # POSITIVE control
grep -c -i 'zzqqx'  -> 0   # NEGATIVE control
```
`/622/Tax-Foreclosure-Sales` (200 / 135,925 B; negative control `/999622/...` → **404** / 116,557 B)
links to a dedicated app, `https://buncombenc.gov/app-tax-foreclosures` (200 / 19,183 B; negative
control `/app-no-such-app-xyz-20260819` → **404**). That app has **0 `<table>`, 0 `<tr>`** — the
listings are client-rendered from **Trumba**, `webName: "tax-foreclosures-all"`.

`trumba.com/robots.txt` → 200 / 48 B, body verbatim:
```
User-agent: *
Disallow: 
# allows all robots
```

⚠️ **THIS IS THE PROBE THAT WAS WRONG AND ITS CONTROL CAUGHT IT.** First attempt:

| probe | HTTP | bytes | reading |
|---|---|---|---|
| `.../calendars/tax-foreclosures-all.ics` | 200 | 225 | valid `VCALENDAR`, name `Tax\|Tax Foreclosures - All`, **0 VEVENT** |
| `.../calendars/tax-foreclosures-all.json` | 200 | 2 | `[]` |
| **negative control** `.../calendars/zzz-no-such-calendar-xyz-20260819.ics` | **410** | 35 | "The page you requested was removed." |

The negative control did its job — it proved the feed *exists* rather than 404s — so I recorded
"Buncombe has zero listings." **That conclusion was wrong.** Adding an explicit date window:

```
curl -A "$UA" 'https://www.trumba.com/calendars/tax-foreclosures-all.ics?filterview=&startdate=20190101&enddate=20271231'
```
→ **200 / 102,572 B / 60 VEVENT.** The default ICS window silently excludes past events. A control
that only proves "the endpoint is real" does not prove "the query returned everything."

A second control — a plausible-but-wrong calendar name `buncombe-county-calendar.ics` → **410** —
confirms 410 vs 200 discriminates name-exists from name-absent.

**Payload shape (one VEVENT, verbatim):**
```
SUMMARY:CLEAR BRANCH BAPTIST CHURCH
DTSTART;TZID=America/New_York:20220126T113000
DTEND;TZID=America/New_York:20220204T170000
GEO:35.528851;-82.251398
DESCRIPTION:Opening/Current Bid: 31\,000<br>Redeemed: No<br>Case Number: 21 CV 3721<br>
  PIN lookup: .../Default.aspx?PINN=063623822700000<br>Property Type: Land & Structures<br>
  Fire District: BROAD RIVER<br>...0.83 ACRES\, MORE OR LESS
X-TRUMBA-CUSTOMFIELD;NAME="Opening/Current Bid";TYPE=Currency:31\,000
X-TRUMBA-CUSTOMFIELD;NAME="Redeemed";TYPE=Boolean:No
X-TRUMBA-CUSTOMFIELD;NAME="Case Number";TYPE=SingleLine:21 CV 3721
X-TRUMBA-CUSTOMFIELD;NAME="Property Type";TYPE=CustomAsset:Land &amp\; Structures
UID:http://uid.trumba.com/event/157320773
```

This is the best-structured distress payload in the entire run: **lat/lon, parcel PIN, opening bid,
redeemed flag, case number, property type, acreage, bidding window** — typed custom fields, no HTML
scraping, no OCR. The PIN joins to NC OneMap `parno`.

**Measured inventory (corrected figures):**
```
VEVENTs                              : 60
span                                 : 2022-01-18 -> 2026-08-07  (4.55 yr)  => ~13/yr
Redeemed=No (i.e. actually sold)     : 35 / 60                               => ~7.7/yr
events dated >= today (2026-08-19)   : 0
2026 YTD events                      : 7   (4 not redeemed)
feed lastBuildDate                   : 07 Aug 2026  (12 days stale)
```
Control on the date-threshold arithmetic (an earlier version of this test had a negative control that
also returned 0, i.e. it could not fail):
```
total DTSTART values        : 62      # 62 raw vs 60 unfolded — line-folding artifact, unfolded value is authoritative
>= 20000101 (POS control)   : 62      # must equal total  -> passes
>= 20990101 (NEG control)   : 0       # must be 0         -> passes
>= 20260819 (today)         : 0
max DTSTART                 : 20260807
```

**Buncombe has zero tax-foreclosure sales open right now.** That is now a measured absence, not a
broken probe.

### §2.5 Jackson — a third mechanism again, and real purchasable stock

Jackson's sitemap (200 / 43,567 B, 295 `<loc>`), grep with controls:
```
grep -o -i '<loc>[^<]*foreclos[^<]*</loc>'  ->  (no matches)
grep -c -i 'tax'    -> 5   # POSITIVE control passes
grep -c -i 'zzqqx'  -> 0   # NEGATIVE control passes
```
**Jackson has no tax-foreclosure page at all** — a real absence, proven by a working grep.

But `/456/Tax-Collections` (200 / 124,322 B; `foreclos` = 2 hits, positive control `tax` = 14,
negative `zzqqx` = 0) carries three PDFs:

| document | URL | HTTP | bytes | pages | text layer? |
|---|---|---|---|---|---|
| **County Properties Acquired Through Foreclosure** | `/DocumentCenter/View/2164` | 200 | 16,360 | 1 | **YES** (5 `/Font`) |
| Delinquent Accounts as of 2026-08-03 | `/DocumentCenter/View/2221` | 200 | 4,855,020 | **73** | **YES** (77 `/Font`) |
| Upcoming Property Tax Foreclosure Sales | — | — | — | — | page states **"None Currently Scheduled"** |

Text extracted from the REO PDF (zlib + PDF text operators, stdlib only) — **8 county-owned
properties currently for sale**, each with parcel PIN, assessed value, owner/lot description, amount
owed, interest, and date acquired. Sample rows:
```
7662-23-2593  $27,270  Bush, Bonnie   Lt 12 Hickory Ridge      9,500.00  $103.59  6/2024
7592-65-6317  $14,000  Clark, Rennie Jr Lt 34 Un 14 Holly Forest 3,360.00  $-      11/2023
7543-84-6088  $21,620  Lester, Charles Lt 3 C Yellow Mtn        6,300.00  $79.86   3/2025
```
Contact for purchase is named on the document. **This is directly purchasable, genuinely off-market
inventory — exactly the owner's success criterion.**

### §2.6 Verdict — **PARTIAL PASS. The pattern does NOT generalise in shape.**

| county | mechanism | machine-readable? | open inventory today |
|---|---|---|---|
| Haywood | CivicEngage Bids module, `CatID=17` | list yes, **property detail = scanned PDF, OCR needed** | **3** |
| Buncombe | **Trumba ICS/RSS/JSON**, typed custom fields | **yes, excellent** | **0** (7 YTD, 4 unredeemed) |
| Jackson | static PDFs on the Tax Collections page | yes, text layer present | **8 county-owned REO** |

Three target counties, **three unrelated mechanisms**. A19 generalises as an *intent* (every NC county
publishes something) but not as a *shape*. **"One NC foreclosure scraper" is false**; budget
per-county adapters. Rate variance is ~4× (Haywood ~17/yr vs Buncombe ~13/yr despite Buncombe having
2.5× the parcels), so per-county extrapolation from a single county is unsafe.

---

## §3 — GA + VA statewide public-notice aggregators — **FAIL (ToS, not robots)**

Claims under test: **B8** (georgiapublicnotice.com), **B12/B13** (publicnoticevirginia.com).
⚠️ `vapublicnotices.com` re-confirmed **NXDOMAIN** (curl exit 6, "Could not resolve host") — do not use.

### §3.1 robots.txt versus OUR user agent specifically — **ALLOW**

```
curl -A "$UA" https://www.georgiapublicnotice.com/robots.txt   -> 200, 1,535 B
curl -A "$UA" https://www.publicnoticevirginia.com/robots.txt  -> 200, 1,536 B
curl -A "$UA" https://www.vapublicnotices.com/robots.txt       -> exit 6, NXDOMAIN
```
B9/B13 confirmed verbatim: `User-agent: *` → `Allow: /` (only `/App_Code/ /aspnet_client/ /Bin/
/Scripts/ /UserControls/` disallowed), then **25 named AI/scraper agents each `Disallow: /`**
(Amazonbot, anthropic-ai, Applebot-Extended, Bytespider, CCBot, **ClaudeBot**, Claude-Web, cohere-ai,
DataForSeoBot, Diffbot, FacebookBot, Google-Extended, ImagesiftBot, **GPTBot**, magpie-crawler,
NewsNow, news-please, omgili, omgilibot, peer39_crawler, **PerplexityBot**, **Scrapy**, TurnitinBot…).

The verdict for our UA is a **scripted match, not an eyeballing**:

| | georgiapublicnotice.com | publicnoticevirginia.com |
|---|---|---|
| User-agent groups declared | 32 (31 named) | 32 (31 named) |
| **named agents matching OUR UA** | **0** `[]` | **0** `[]` |
| POSITIVE control — a ClaudeBot UA | **1** `['ClaudeBot']` | **1** `['ClaudeBot']` |
| NEGATIVE control — a `zzqqx` UA | 0 | 0 |
| `Crawl-delay` directives | 0 | 0 |
| `*` group verdict | **Allow /** | **Allow /** |

**robots.txt verdict for our honest UA on both hosts: ALLOW.** Our product token is
`blue-ridge-deal-finder`, which is not a substring of any of the 31 named agents; the ClaudeBot
positive control proves the matcher fires when it should.

### §3.2 ⛔ Terms of Use — **PROHIBITIVE. This overrides the robots.txt allow.**

Both sites expose `/Terms-of-Use.aspx`, which B8/B12 recorded as "ToS unverified / not found".
It is neither — it is one fetch away.

```
curl -A "$UA" https://www.georgiapublicnotice.com/Terms-of-Use.aspx   -> 200, 148,837 B
curl -A "$UA" https://www.publicnoticevirginia.com/Terms-of-Use.aspx  -> 200, 153,910 B
```
Grep controls (both files): `notice` → 31 / 22 hits (**positive control passes**); `zzqqx` → 0
(**negative control passes**); `spidering` → 2 / 2; `automated` → 2 / 2.

**Verbatim, identical on both sites:**

> "You may not, for example, incorporate the content in any database, compilation, archive or cache.
> You may not modify, copy, distribute, transmit, display, perform, reproduce, publish, reuse, resell,
> trade, license, create derivative works from, transfer, sell, or otherwise exploit for any
> commercial purposes any information, software, products or services obtained from this site.
> **You may not engage in any screen scraping, database scraping, or spidering, or collection of
> personally identifiable information, or use of any other automated means to collect information
> from the site.** You may not use any software, tool, or other device (such as browsers, spiders, or
> avatars) to search the site, other than the search functionality offered through the site or other
> generally available web browsers."

This forbids, by name: screen scraping, database scraping, spidering, **any other automated means**,
**and caching or incorporating the content into a database** — which is the entire architecture.

### §3.3 Verdict — **FAIL**

`tos.verdict: prohibitive` → the registry guard (plan §3.3 mechanism 2) refuses the source outright.
Robots permission does not cure an explicit contractual prohibition; the ToS is the stricter
instrument and it is unambiguous.

**Both sites move from 🟡 YELLOW to 🔴 RED and belong in `sources.denied.yaml`.** This is a
correction to the B-scorecard, which rated them usable pending an unfetched ToS. GA (9 counties) and
VA (9 counties) lose their statewide notice lane entirely.

---

## §4 — TN third-party posting sites (B14/B15) — **INCONCLUSIVE / partly NOT RUN**

**⚠️ Tooling limit, stated plainly:** this agent had no web-search tool, only `curl`. B14's question —
*does a named third-party foreclosure-posting site exist for a TN target county* — requires reading a
newspaper ad to learn the site's name. **I could not perform that search. That half of probe 4 is
NOT RUN, not "not found."**

What I could probe, by direct URL:

```
curl -A "$UA" https://publicnoticeads.com/robots.txt     -> 200,      77 B
curl -A "$UA" https://publicnoticeads.com/tn/            -> 404,  68,971 B
curl -A "$UA" https://www.tnpublicnotice.com/robots.txt  -> 200,   1,531 B
curl -A "$UA" https://www.tnpublicnotice.com/            -> 200, 200,314 B
curl -A "$UA" https://example.com/                       -> 200,     559 B  (positive control)
curl -A "$UA" https://example.com/…bogus…                -> 404,     559 B  (negative control)
```

**B15's gap is closed on reachability:** `tnpublicnotice.com` is **live** (B15 recorded both TN
fetches as failed). `publicnoticeads.com` is live but `/tn/` is a 404 — B15's path is wrong.

`tnpublicnotice.com/robots.txt` is **the same vendor template as GA and VA** (`/App_Code/`,
`/aspnet_client/`, `/Bin/`, `/Scripts/`, `/UserControls/`, `Allow: /Masters/`), so §3's ToS finding
was expected to carry over. It does not, and the reason is worse:

```
curl -A "$UA" https://www.tnpublicnotice.com/Terms-of-Use.aspx  -> 200, 164,630 B
grep -c -i 'notice'          -> 27   # POSITIVE control passes
grep -c -i 'zzqqx'           ->  0   # NEGATIVE control passes
grep -c -i 'screen scraping' ->  0
grep -c -i 'spidering'       ->  0
grep -c -i 'automated means' ->  0
```
The anti-scraping clause is genuinely absent — but reading the page shows why:

> "This Public Notice Database (www.tnpublicnotice.com) … is hereby established pursuant to
> **Illinois Public Act 96-1144** as the statewide website … of the majority of **Illinois**
> newspapers. … These Terms explain the contractual agreement between you and **Illinois Press
> Association, Inc. ("IPA")** … IPA provides the Public Notice Database in an effort make public
> notices easily accessible in the **State of Illinois**." (contact: `publicnotice@tnpress.com`)

**The Tennessee site's Terms of Use are an un-edited copy of the Illinois site's.** The absence of a
scraping clause is a transcription defect, not a grant of permission.

**Verdict: INCONCLUSIVE.** Reachability PASS; legal posture unusable — I will not read permission
into a contract that names the wrong state and the wrong party. What would settle it: an email to
`publicnotice@tnpress.com` asking for the applicable terms, or a TN Press Association ToS at a
different URL. B14's named-posting-site question remains **NOT RUN**, deferred to an agent with search.

---

## §5 — qPublic JSON/ArcGIS backend spike — **FAIL. PRE-COMMITTED KILL FIRED.**

Testing only whether a JSON/ArcGIS backend exists on a *different host* than the confirmed-walled app
page (E1.1–E1.4), with each host's own robots.txt re-checked independently.

| target | HTTP | bytes | body |
|---|---|---|---|
| `qpublic.schneidercorp.com/robots.txt` | 200 | 2,468 | reachable |
| `beacon.schneidercorp.com/robots.txt` | 200 | 2,468 | byte-identical to above |
| `qpublic.net/robots.txt` | 200 | 1,248 | reachable |
| **`gis.qpublic.net/robots.txt`** | **530** | 17 | `error code: 1016` |
| **`gis.qpublic.net/arcgis/rest/services?f=json`** | **530** | 17 | `error code: 1016` |
| `qpublic.schneidercorp.com/arcgis/rest/services?f=json` | **403** | 5,798 | Cloudflare wall |
| `qpublic.schneidercorp.com/api/` | **403** | 5,799 | Cloudflare wall |
| `qpublic.schneidercorp.com/Application.aspx?AppID=1050&…` | **403** | 5,798 | Cloudflare wall (E1.1 reproduced exactly) |
| control positive (example.com) | 200 | 559 | — |

Cloudflare **1016 = Origin DNS error**: `gis.qpublic.net` has no working origin. Not a bot block — a
dead host.

⛔ **And the robots.txt itself forbids the app page for our UA**, which E1 did not record:
```
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /
...
User-agent: *
Disallow: /Application.aspx
Disallow: /application.aspx
Disallow: /print.aspx
Disallow: /renderpdf.aspx
Disallow: /filedata/     (+ case variants)
```
(ClaudeBot, GPTBot, CCBot, Bytespider, Amazonbot, Google-Extended, meta-externalagent,
Applebot-Extended, CloudflareBrowserRenderingCrawler each `Disallow: /`.)

**Verdict: FAIL — kill criterion met. qPublic is CLOSED PERMANENTLY.** Two independent grounds:
robots.txt disallows `/Application.aspx` for `*`, and every non-robots path 403s. No further hour is
to be spent here. The GA (9) and SC (3) counties that qPublic serves must be reached another way or
not at all.

---

## §6 — VA host discrepancy — **PASS (question answered; answer is negative)**

| target | HTTP | bytes | result |
|---|---|---|---|
| `vginmaps.vdem.virginia.gov/arcgis/rest/services?f=json` | **200** | 155 | ArcGIS **11.3**, 9 folders |
| `gismaps.vdem.virginia.gov/arcgis/rest/services?f=json` | — | — | **curl exit 6, NXDOMAIN** |
| `vginmaps.vdem.virginia.gov/robots.txt` | **200** | 97 | see below |
| control positive / negative | 200 / 404 | 559 / 559 | — |

`vginmaps` body: `{"currentVersion":11.3,"folders":["Build_Services","Download","Geocoding","NG911",
"Utilities","VA_Base_Layers","VBMP_Imagery","VGIN","VPDC"],"services":[]}`

⛔ **`vginmaps.vdem.virginia.gov/robots.txt`, complete body:**
```
User-agent: *
Disallow: /arcgis/
Disallow: /Download/
Disallow: /VGIN/
Disallow: /websites/
```

**The live host disallows `/arcgis/` — the exact path its REST services live on**, plus `/Download/`
and `/VGIN/`. A4 recorded this host as "fetched OK"; that was true of the fetch and silent on robots.

**Verdict:** `gismaps` is NXDOMAIN (E3.5 confirmed). `vginmaps` is live but **robots-DISALLOWED for
automated access on every useful path.** VA's statewide GIS lane is closed on robots grounds, on top
of E3.5's finding that it carries geometry only. VA's 9 counties have neither a parcel lane nor
(per §3) a notice lane.

---

## §7 — Federal enrichment liveness — **PASS (4/4 live, keyless)**

All four probed in one batch with matched negative controls.

| service | URL | HTTP | bytes | negative control | result |
|---|---|---|---|---|---|
| **USGS NHD** | `hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer?f=json` | 200 | 12,629 | `.../NO_SUCH_SERVICE_XYZ/...` → 200 / 96 B, `{"error":{"code":404,…}}` | **13 layers**, v11.3 |
| **FEMA NFHL** | `hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer?f=json` | 200 | 9,520 | `.../NO_SUCH_XYZ/...` → 200 / 95 B, `{"error":{"code":404,…}}` | **33 layers**, v11.1 |
| **USGS EPQS** | `epqs.nationalmap.gov/v1/json?x=-81.6746&y=36.2168&units=Meters&wkid=4326&includeDate=true` | 200 | 206 | `x=-999&y=-999` → **200** / 49 B, plain text | **980.410034180 m** at Boone NC, 1 m res, acquired 2017-10-06 |
| **Census TIGERweb** *(never probed by anyone in this run)* | `tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer?f=json` | 200 | 25,205 | `.../NO_SUCH_XYZ/...` → 200 / 65 B, `{"error":{"code":404,…}}` | **"Census Current (2025) WMS"**, Jan 1 2025 vintage, v11.5 |
| control positive / negative | example.com | 200 / 404 | 559 / 559 | — | — |

**Query shapes:** all four are keyless GET. NHD/NFHL/TIGER are ArcGIS REST
(`/query?geometry=…&geometryType=esriGeometryPoint|Polygon&spatialRel=…&outFields=…&f=json`).
EPQS is a single point lookup returning elevation in metres plus acquisition date.

⛔ **Two silent-green traps recorded:**
1. **Every** ArcGIS negative control returns **HTTP 200** with an `error` object in the body. A
   status-only health check reads a dead service as healthy. This is E7.4/E7.5 reproduced on three
   more hosts — the assertion must be on the body.
2. **EPQS returns HTTP 200 with a plain-text error**, `"The operation was attempted on an empty
   geometry."` — not even JSON. A parser expecting JSON will throw; a status check will pass.

---

## §8 — ArcGIS pagination stability (RT-2) — **PASS**

Layer: `https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1`
(metadata: 200 / 12,387 B, `"name":"Parcels (polys)"`, `"geometryType":"esriGeometryPolygon"`,
`"maxRecordCount":5000` — E6.2 re-confirmed in passing).

### §8.1 ⛔ `objectIdFieldName` is ABSENT, and the OID field is lowercase

```
grep -c 'objectIdFieldName' ag-meta.body  ->  0    # the property the task asked for is NOT PRESENT
grep -c '"fields"'          ag-meta.body  ->  1    # POSITIVE control: the grep does match this file
grep -c 'zzqqx'             ag-meta.body  ->  0    # NEGATIVE control
```
The layer metadata does **not** expose `objectIdFieldName`. A client reading it gets `undefined`.
The OID field is `objectid` (**lowercase**, `type: esriFieldTypeOID`, alias `OBJECTID`). Query
responses echo `"fieldAliases":{"objectid":"OBJECTID"}`.

⚠️ **`outFields=OBJECTID` (uppercase) works, but the returned attribute key is `objectid`.** Code
that writes `feature.attributes.OBJECTID` reads `undefined` — the exact `undefined < 45000 === false`
shape that this run has already been bitten by.

### §8.2 Determinism — same offset twice

```
Q='where=cntyname=%27Watauga%27&outFields=objectid&returnGeometry=false&orderByFields=objectid&resultRecordCount=500&f=json'
run A: resultOffset=10000   -> 200, 32,294 B, sha256 9f0ff63ac8153346…
run B: resultOffset=10000   -> 200, 32,294 B, sha256 9f0ff63ac8153346…   IDENTICAL
control: resultOffset=10500 -> 200, 18,687 B, sha256 0379afd176761c49…   DIFFERENT
```
⚠️ **The first version of this test was inert.** Comparing ordered vs unordered queries produced four
identical hashes, so "identical" carried no information. The discriminating control is a *different
offset*: it produces a different hash, proving the hash test can fail.

Page overlap — **and the regex bug the control caught:**
```
grep -o '"objectid":[0-9]*'      -> 501 rows, overlap 1   # WRONG: [0-9]* matches ZERO digits,
                                                          # so the "objectid" key in fieldAliases matched
grep -o '"objectid":[0-9][0-9]*' -> 500 rows, overlap 0   # CORRECT
POSITIVE control: page@10000 vs itself -> overlap 500     # proves `comm` works
```
**500 rows per page, 0 overlap between adjacent pages.**

### §8.3 OBJECTID envelope for one county

```
orderByFields=objectid ASC,  resultRecordCount=1  -> {"objectid":33897567}
orderByFields=objectid DESC, resultRecordCount=1  -> {"objectid":33944954}
outStatistics min/max on 'objectid'               -> {"mn":33897567,"mx":33944954}   (agrees)
```
`33944954 − 33897567 + 1 = 47,388` — **exactly** the Watauga row count from E2.7 and from §0's control.
The OBJECTID block is **contiguous with no gaps**.

⚠️ **Failed sub-probe, recorded:** the first `outStatistics` attempt used `onStatisticField:"OBJECTID"`
(uppercase) and returned **HTTP 200** with
`{"status":"error","messages":["Could not access any server machines. Please contact your system
administrator."]}` — a misleading infrastructure-sounding message for what is a field-name error, at
HTTP 200. Third instance of the status-200-on-error trap in this log.

**Verdict: PASS.** `resultOffset` pagination on `MapServer/1` is stable and non-overlapping under a
control that can fail. Requires `orderByFields=objectid` in production regardless, since stability
without an explicit sort is not guaranteed by the ArcGIS contract even though it held here.

---

## §9 — NCDOR reappraisal schedule → `seeds/dim_county_assessment.csv` — **PASS**

The task's URL was not given; the page had moved. Discovery trail, with every step recorded:

| step | URL | HTTP | bytes |
|---|---|---|---|
| guessed path | `/taxes-forms/property-tax/property-tax-commission-and-legal-resources/property-tax-rates-and-reappraisal-schedules` | **404** | 66,547 |
| negative control | `/zzqqx-not-a-real-page-20260819` | **404** | 66,175 |
| robots.txt | `www.ncdor.gov/robots.txt` | 200 | 1,689 |
| sitemap index | `/sitemap.xml` | 200 | 434 |
| sitemap pages 1+2 | `/sitemap.xml?page=1,2` | 200 | 1,124,273 + 269,194 |
| landing page | `/taxes-forms/property-tax/property-tax-rates/county-property-tax-rates-and-reappraisal-schedules` | **200** | 85,521 |
| current fiscal year | `/fiscal-year-2026-2027` | **200** | 84,051 |
| **the data file** | `/2026-2027countytaxratesfinalxlsx/open` | **200** | **18,979** |
| control positive | example.com | 200 | 559 |

robots.txt: `Disallow: /search/ /admin/ /core/ /profiles/ /user/*` — the paths used here are **allowed**.

Sitemap search control (6,139 `<loc>` across both pages):
```
grep -c -i 'property' -> 427   # POSITIVE control
grep -c -i 'zzqqx'    ->   0   # NEGATIVE control
```

`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`filename="2026-2027_County_Tax_Rates_Final.xlsx"`, parsed with Python stdlib `zipfile` + `ElementTree`.
Columns: `Counties | Tax Rate | Year of Latest Reappraisal | Next Scheduled Reappraisal`.

**Completeness assertion — the script refuses to write an incomplete seed:**
```
counties parsed from XLSX                         : 100      (all NC counties)
NC targets in seeds/counties.csv                  :  11
MISSING from NCDOR table                          :  []      <-- must be [], else abort
CONTROL: 'Alamance' present AND 'Zzzznotacounty' absent : True  <-- must be True, else abort
```

**Written: `seeds/dim_county_assessment.csv`, 11 rows + header.**

⛔ **Load-bearing finding — assessment vintage spans four years across the 11 NC counties:**

| county | last reappraisal | next | cycle |
|---|---|---|---|
| Buncombe, Haywood | **2021** | 2027 | 6 |
| Avery, Mitchell, Watauga | **2022** | 2027 | 5 |
| Ashe, Henderson | **2023** | 2027 | 4 |
| Madison, Yancey | **2024** | 2032 | 8 |
| Jackson, Transylvania | **2025** | 2029 | 4 |

A raw "price vs assessed value" discount is **not comparable across counties**: Buncombe and Haywood
values are five years stale while Jackson and Transylvania are one year stale, and G.S. 105-287 bars
inter-reappraisal adjustment for general economic change. The score must normalise by
`last_reappraisal_year` per `fips`. This confirms CE-3's conclusion (E8.3) with measured numbers.

⚠️ **Discrepancy flagged, not edited** (`seeds/counties.csv` is P1's file): its Buncombe note reads
"REAPPRAISAL 2026 — 26.8% of corpus reprices this year". NCDOR's 2026-2027 table says Buncombe's
latest reappraisal is **2021** and its next is **2027**. Team Lead's call.

---

## §10 — Oconee SC Master-in-Equity re-probe — **INCONCLUSIVE (and the prior 500 is now explained)**

The prior run recorded HTTP 500 / 0 B — "neither present nor absent".

```
curl -A "$UA" https://www.oconeesc.com/robots.txt                        -> 200,     467 B
curl -A "$UA" https://www.oconeesc.com/                                  -> 200, 114,904 B
curl -A "$UA" https://www.oconeesc.com/departments/master-in-equity      -> 500,       0 B   <-- REPRODUCED
curl -A "$UA" https://www.oconeesc.com/departments/zzqqx-not-a-real-…    -> 500,       0 B   <-- DISCRIMINATING CONTROL
curl -A "$UA" https://www.oconeesc.com/departments                       -> 200, 114,904 B
curl -A "$UA" https://example.com/                                       -> 200,     559 B
```

⛔ **A deliberately bogus department path returns the byte-identical HTTP 500 / 0 B.** Therefore the
500 means **"no such path"** on this Joomla site, not "server broken". The prior finding was a wrong
URL misread as an outage. **This row is the phase's acceptance control: a previously-known 500
recorded as a real FAIL/INCONCLUSIVE, with the control that explains it.**

⚠️ **Second trap:** `/departments` returns 200 with **exactly 114,904 bytes — byte-identical to the
homepage.** A "200 + large body" check reads a soft-alias as a successful department fetch.

Real surface found via the Joomla `jmap` sitemap (200 / 25,278 B, 162 `<loc>`; positive control
`tax` = 12, negative `zzqqx` = 0):
```
https://oconeesc.com/delinquent-tax/sale-list
https://oconeesc.com/delinquent-tax/tax-sale-information
https://oconeesc.com/delinquent-tax/bidder-registration
https://oconeesc.com/delinquent-tax/tax-sale-information/overage-information
```
`/delinquent-tax/sale-list` → **200 / 114,638 B**, `<title>Sale List</title>`, distinct from the
homepage (sha256 differs), **4 `<table>`**. Table 0 header: `Item Number | Owner Name | Map Number |
Description | Total Tax Due`, and the page states:

> "The 2026 Tax Sale is scheduled for **Monday, November 9, 2026**. The list of properties will be
> available online and published in the local newspaper starting **Wednesday, October 21, 2026**.
> Bidder Registration will be open … October 29 through November 5, 2026."

robots.txt allows it (`Disallow:` only `/administrator/ /cache/ /cli/ /includes/ /installation/
/language/ /libraries/ /logs/ /tmp/`).

**Verdict: INCONCLUSIVE — reachability PASS, inventory count not yet determinable.** The table exists
and its columns are known, but **the rows do not publish until 2026-10-21**. That is a scheduled
future availability, not an absence. What would settle it: re-probe on or after 2026-10-21.
No Master-in-Equity roster was located for Oconee (B-claim 17's warning that the Greenville pattern
may not generalise stands, unresolved).

---

## Probe summary

| # | probe | verdict | one-line result |
|---|---|---|---|
| 0 | global control block | **PASS** | success / 404 / DNS-failure / real-vs-empty all distinguishable |
| 1 | **LandSearch** | **FAIL** | Cloudflare `cf-mitigated: challenge`; 403 on every path incl. its own advertised sitemaps; 3 UAs all blocked |
| 1b | LandSearch MLS-derivation | **INCONCLUSIVE** | unanswerable — no listing reachable; moot, source is unusable either way |
| 2 | NC per-county foreclosure | **PARTIAL PASS** | 3 counties → 3 unrelated mechanisms; 11 purchasable properties today |
| 3 | GA + VA aggregators | **FAIL** | robots ALLOWS our UA (0/31 named agents match) but **ToS prohibits all automated collection** |
| 4 | TN posting sites | **INCONCLUSIVE / partly NOT RUN** | `tnpublicnotice.com` live (B15 gap closed); its ToS is **Illinois** boilerplate; B14 needs a search tool |
| 5 | qPublic backend | **FAIL — KILL FIRED** | robots disallows `/Application.aspx`; all paths 403; `gis.qpublic.net` = CF 1016 dead origin |
| 6 | VA host discrepancy | **PASS (negative)** | `vginmaps` live but robots `Disallow: /arcgis/`; `gismaps` NXDOMAIN |
| 7 | NHD / NFHL / EPQS / TIGER | **PASS** | 4/4 live and keyless; 2 status-200-on-error traps recorded |
| 8 | ArcGIS pagination (RT-2) | **PASS** | stable, 0 overlap, envelope contiguous == 47,388; `objectIdFieldName` **absent**, OID is lowercase |
| 9 | NCDOR reappraisal | **PASS** | seed written, 11/11 assertion; vintage spans 2021–2025 |
| 10 | Oconee SC | **INCONCLUSIVE** | 500 explained as "no such path"; real sale-list found, **rows publish 2026-10-21** |

**FAIL rows: 3. INCONCLUSIVE rows: 3. NOT RUN: 1.** The acceptance control is satisfied.

---

## GO / NO-GO

### The verdict that decides the project, first

**LandSearch is unusable, and the MLS-vs-disjoint question is therefore unanswered and moot.** It was
the only 🟢 GREEN land source in the entire research pass, and that rating rested on a `robots.txt`
that the site's own Cloudflare edge does not honour. Every content path — including the seven
sitemaps its `robots.txt` advertises — returns HTTP 403 with `cf-mitigated: challenge`, under our
honest UA, under a default curl UA, and under a browser UA alike.

The finding the task anticipated has landed by a different route than expected: **the on-market lane
collapses to distress-only.** Not because LandSearch turned out to be MLS-derived and redundant, but
because it cannot be read at all. Zillow/Redfin/Realtor were already out of scope; LandWatch,
LandAndFarm, LandsOfAmerica, ByOwner and Ten-X were already edge-walled; FSBO-by-owner sources are
robots-blocked on exactly their listing paths. **There is no reachable general for-sale listing
source. The project cannot be a "browse everything for sale in the Blue Ridge" site.**

### So: is there enough purchasable inventory to justify building the rest?

**Measured, today, from sources that are both robots-clean and ToS-clean:**

| county | source | open, purchasable right now |
|---|---|---|
| Haywood NC | CivicEngage Bids `CatID=17` | **3** foreclosure sales (auction 2026-08-20) |
| Jackson NC | county REO PDF | **8** county-owned foreclosed properties, listed with PIN, assessed value and price owed |
| Buncombe NC | Trumba ICS | **0** open (7 events YTD, 4 unredeemed; ~13/yr, ~7.7/yr reaching sale) |
| Oconee SC | delinquent-tax sale list | **unknown** — annual sale 2026-11-09, list publishes 2026-10-21 |
| **total, 4 of 38 counties** | | **11 properties visible today** |

**Annualised run-rate for the three NC counties measured: ~30 foreclosure events/year**
(Haywood 122 over 7.2 yr ≈ 17/yr; Buncombe 60 over 4.55 yr ≈ 13/yr; Jackson publishes stock rather
than events). Rates vary ~4× between adjacent counties, so extrapolating the 11 NC counties from
these three gives a range, not a number: **plausibly 60–120 distress events per year across NC's 11
target counties, with roughly 10–20 purchasable at any given moment.**

That is the honest number. **It is thinner than hoped.** This is a tool that will surface roughly a
dozen properties at a time, refreshed as counties post — not a site with hundreds of browsable
listings. The ≥25-row ship gate in the plan is **not met by NC distress alone today** (11 measured),
and the plan's TB1 §3.2 escape hatch should be exercised: **replace the 25-row gate with a measured
floor of 10 rows across the NC lane.**

### And the other three states are materially worse than the plan assumed

Every non-NC lane probed in this phase closed:

- **GA (9 counties):** qPublic closed permanently (§5), and `georgiapublicnotice.com`'s ToS forbids
  all automated collection and all caching (§3). GA has no statewide parcel layer (E3.6). **GA has no
  probed-open lane at all.**
- **VA (9 counties):** `publicnoticevirginia.com` carries the identical prohibitive ToS, and VGIN's
  live host robots-disallows `/arcgis/` (§6). **VA has no probed-open lane at all.**
- **TN (5 counties):** the aggregator is reachable but its Terms of Use are a copy of Illinois's
  (§4); B14's mandated third-party posting site was not searchable with this agent's tools.
  **Unresolved, not closed.**
- **SC (3 counties):** Oconee has a real, robots-clean tax-sale list — with rows arriving 2026-10-21.
  The one genuinely promising non-NC surface found.

**The 38-county scope is, on today's evidence, an 11-county project with a 4-county maybe.**

### What is unambiguously strong

The **analytical substrate is excellent and fully open**, and it is the part a paid MLS feed would
not give him:

- NC OneMap `MapServer/1`: 503,674 parcel **polygons** across all 11 NC counties, with assessed
  value, acreage, last sale date and use code — pagination now proven stable with a control that can
  fail (§8).
- USGS NHD (13 layers), FEMA NFHL (33 layers), USGS EPQS (1 m elevation), Census TIGERweb (2025) —
  all live, all keyless, all confirmed this phase (§7). Water, floodplain, slope and road access are
  computable from geometry, on vacant land where addresses are empty.
- Assessment vintage is now a measured per-county constant (§9), so the discount score can be made
  cross-county comparable rather than silently wrong.

### Recommendation: **CONDITIONAL GO — rescope before building**

Build it, but build the honest version:

1. **Scope P1–P4 to NC's 11 counties.** They are the only state with both an open parcel lane and an
   open distress lane. Treat GA/VA/SC/TN as a separately-scoped, separately-risked follow-on, not as
   "and then the other 27 the same way."
2. **Reposition the product.** It is a *parcel intelligence and distress-alert* tool over 503,674 NC
   parcels — "score every parcel in the NC mountains on $/acre, water, slope and floodplain, and tell
   me the moment a distressed one appears" — not a listing aggregator. The differentiator is the
   geometry-derived scoring, which is genuinely not on Zillow.
3. **Replace the ≥25-row ship gate with a measured floor of 10**, per the plan's own escape hatch.
4. **Budget three per-county adapters, not one NC scraper**, and budget OCR for Haywood (§2.3).
5. **Put `georgiapublicnotice.com`, `publicnoticevirginia.com`, `landsearch.com`, all Schneider
   qPublic/Beacon hosts, and `vginmaps.vdem.virginia.gov/arcgis/` into `sources.denied.yaml`** before
   any fetcher code runs.
6. **Owner decision needed:** with the on-market lane closed, is a tool that surfaces ~10–20
   distressed NC properties at a time, over a rich parcel-scoring layer, worth the build? That is a
   preference call, not a technical one, and it should be made now rather than at P4.

### Open questions this phase could not close

- LandSearch MLS-derivation (§1.5) — needs 15 minutes of human browsing.
- TN's named third-party foreclosure posting site (§4, B14) — needs a web-search tool.
- TN aggregator's applicable Terms of Use (§4) — needs an email to the TN Press Association.
- Oconee SC row count (§10) — re-probe on 2026-10-21.
- Whether a `robots.txt`-allow can be relied on where the operator's ToS says otherwise (§3) —
  answered "no" here, conservatively. Worth an explicit owner ruling in `docs/decisions/`.
