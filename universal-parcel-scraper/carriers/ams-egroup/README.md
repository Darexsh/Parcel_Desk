# AMS eGroup

AMS eGroup parcels use enabled universal providers. There is no dedicated adapter.

AMS eGroup, formerly eRetail Logistics, is a Sydney e-commerce logistics group: customs clearance,
fulfilment, mail services and last-mile delivery in Australia and New Zealand. Its site is
amsegroup.com.au.

## Numbers

Its etrack IDs have no published layout and no public example, so there is no rule. Its parcels
also carry the final-mile carrier's number, such as Australia Post's, Aramex's or Team Global
Express's, which those carriers track.

## Why there is no adapter

Its etrack app reads a JSON API without a session, but only over plain HTTP on a non-standard
port, and no public ID is known to confirm an answer.

## Links

The etrack app takes IDs in a form, so no portal link is published.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
