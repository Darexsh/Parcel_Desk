# Juxi Express

Juxi Express parcels use enabled universal providers. The Juxi-only Track718 integration
uses the carrier the sender selects on its guest page; it is not native carrier confirmation.
See [Track718](../../providers/track718/README.md).

Juxi Express is 上海驹隙国际物流有限公司 (驹隙物流), a Shanghai cross-border forwarder whose site
is juxiex.com, with express and postal small-parcel lines. Universal providers name it SHJX.

## Numbers

Its waybills are JXC, two letters, ten digits and YQ. Forwarders on the Hualei (华磊) platform
end their waybills with YQ and open them with their own code, as [GZYL](../gzyl/README.md) does,
and Juxi Express's old tracker ran on that platform. A sample on ParcelPanel's Juxi Express page
and parcels a universal provider files under SHJX share the layout, and no other carrier's rule
takes it, so `juxi-express-1` has high confidence.

## Links

No tracking page of the carrier remains, so no link opens one parcel.

## Why there is no adapter

The site's tracking and login links opened a Hualei tracker on a bare address, and later on two
others. The site has commented the last two out, none of the three answers, Hualei's own tracker
does not hold Juxi Express waybills, and the service terms send customers to 17TRACK. So Juxi
Express stays on universal providers.

[Dianxiaomi's Hualei integration list](https://help.dianxiaomi.com/article/customerService/98)
and [Sumool's carrier directory](https://shipping.sumool.com/?pageIndex=17&pagesize=20)
still name Shanghai Juxi. Sumool exposes its shipping-channel catalogue, but neither listing
publishes a replacement guest tracking endpoint. Track718's Juxi listing points to the same
carrier website. No official guest tracking app was found. A working merchant portal address
could establish the current Hualei service; a new waybill alone cannot restore the retired hosts.
Enabled universal providers remain the usable route.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
