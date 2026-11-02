# ZES Express

ZES Express is the brand of Eshun International Logistics (俄顺国际物流), a Yiwu forwarder carrying
e-commerce parcels from China to Russia, where CDEK delivers them. Its site is zes-express.com.

## Retrieval

The official site's tracking link opens `track_query.aspx` on the plain-HTTP tenant
`120.26.82.200:8080`. Its guest `/webservice/Service.ashx` uses the
[RTB56 protocol](../yypost/rtb56.ts) without a session. The available public records return
shipment summaries with empty scan lists, so they establish no dated native history. ZES Express
parcels use enabled universal providers; there is no dedicated adapter.

The tenant can resolve a merchant reference to another shipment number. A reply must match the
whole `server_hawbcode`, not just echo the input in `shipper_hawbcode`. The page names another
logistics company, so shared-platform branding does not confirm ZES ownership.

## Links

The tracking page uses a slider CAPTCHA and a plain-HTTP bare IP address, so no portal link is
published. A CDEK waybill belongs with [CDEK](../cdek/README.md).

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
