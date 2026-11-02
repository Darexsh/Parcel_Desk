# Xpressbees

Tracks Indian Xpressbees AWBs indexed by the public seller platform at `shipmentv2.xpressbees.com`. The consumer tracking portal uses a separate verification flow; the seller feed does not cover every consumer AWB.

The `direct` step posts an AWB to the anonymous endpoint named by the deployed seller client. That client uses an upstream whose hostname contains `uat`. A reply must identify both the requested AWB and Xpressbees, because the seller platform also tracks other couriers.

The newest scan establishes the current stage: a stale `rto` summary cannot hide a completed return. Return delivery is `returned`, and scans on the return leg retain their ordinary transport milestones. Unavailable seller history is inconclusive, allowing configured universal fallbacks.

Live test: `XPRESSBEES_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/xpressbees`.
