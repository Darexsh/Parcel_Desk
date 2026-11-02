# GESWL Express

GESWL Express parcels use enabled universal providers. There is no dedicated adapter.

GESWL Express (上海翼速国际物流有限公司) is a Shanghai forwarder founded in 1997 that ships from China to Japan,
where Japanese carriers deliver. ParcelsApp and 17TRACK list it as ZCE.

## Numbers

Its own FAQ says its waybill numbers have twelve characters without saying which, and no public page shows
one. Twelve digits would overlap Japan Post, Yamato and Sagawa, so there is no rule.

## Why there is no adapter

The search box on geswl.com opens
`www.geswl.com:8088/ld_express//businessExpressController.do?gotrack&ids={number}`, an open page that lists
each number's history as HTML and puts an unknown one under "その他". A second tracker covers its AliExpress
line. No public number is known to see a found reply.

## Links

The tracking page opens numbers from its `ids` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
