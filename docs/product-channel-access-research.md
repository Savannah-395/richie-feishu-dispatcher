# Product information channel access research

Research date: 2026-08-24

## Scope

This phase answers how product data could be obtained from the 33 Europe and US storefronts in the supplied channel list. It does not collect product records yet. The machine-readable source of truth is `data/product-information-channels.json`.

Run the structured query directly with Node.js:

```powershell
node src/product-channel-research.js
node src/product-channel-research.js --region europe --format markdown
node src/product-channel-research.js --channel amazon-us
```

The proposed normalized output includes identity, title, brand, dimensions, weight, material, specifications, price, availability, seller, source URL/site/country, SKU/MPN/GTIN, images, documents, variants, ratings, raw source attributes, and collection time. Each future adapter must preserve raw attributes because retailer-specific specifications cannot be losslessly forced into one fixed schema.

## Findings

The channels fall into four acquisition paths:

1. **Conditional catalog APIs**: Amazon Creators API, eBay Browse API, and Etsy Open API can support read-oriented product discovery, but all require program enrollment or developer credentials and impose usage rules.
2. **Seller or partner APIs**: OTTO, ManoMano, Wayfair, Zalando, bol, Cdiscount, eMAG, Leroy Merlin, Kaufland, Walmart, Lowe's, Newegg, and Grainger expose or indicate integration surfaces intended for approved sellers, suppliers, or solution partners. They must not be treated as public competitor-catalog APIs.
3. **Partner feeds**: vidaXL's B2B/dropshipping relationship is the clearest feed-oriented option and requires commercial approval.
4. **Web collection assessment**: no suitable public catalog API was identified for the remaining storefronts. That is a research status, not proof that a private API does not exist and not permission to crawl.

For an SPC wall-panel pilot, start commercial/API onboarding with Amazon, eBay, ManoMano, Wayfair, Cdiscount, vidaXL, Leroy Merlin, Home Depot, Lowe's, Houzz, and Build.com because their catalogs are most relevant. Zalando, Newegg, and Northern Tool are retained because they appear in the requested list, but their expected product relevance is low.

## Compliance gate for page collection

Before implementing a collector for any channel classified as `compliant_web_assessment`, record and approve all of the following for the exact locale and URL patterns:

- site terms and any marketplace-specific terms;
- `robots.txt` directives and crawl-delay/rate expectations;
- authentication, geo, cookie, and anti-bot behavior;
- permitted storage, image reuse, and attribution rules;
- personal data avoidance and retention;
- request frequency, retry policy, caching, and deletion process;
- a stable product identifier and a sample field-mapping test.

`robots.txt` is one input to this review; it is not legal authorization by itself. Private browser endpoints must not be reverse engineered and presented as public APIs.

## Recommended next implementation phase

Build one adapter at a time behind a common record contract. Use an official read-oriented API first where credentials are available. For seller/partner APIs, obtain written confirmation that the account may read the required catalog scope. Only after the compliance gate is approved should a storefront page adapter be considered.

The first adapter should be selected based on credentials actually available to the project. This research intentionally does not add credentials, a scraper, scheduled jobs, database changes, or production data storage.
